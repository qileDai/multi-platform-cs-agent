"""RPA Worker 桥接 API：incoming / media / outbox / ack / heartbeat / identity。

鉴权：Worker 接口走 X-Rpa-Key 头（比对 RPA_API_KEY）；/workers 管理接口走 JWT。
协议细节见 docs/rpa-workers.md。
"""
import hmac
import logging
import os
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..core import audit, monitor
from ..core.queue import enqueue
from ..database import get_db
from ..models import Agent, RpaIdentityMap, RpaMedia, RpaOutbox, RpaWorker
from ..schemas import (RpaAck, RpaHeartbeat, RpaIncoming, RpaIncomingComment,
                       RpaIdentityResolve, RpaWorkerOut)
from .deps import get_current_agent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rpa", tags=["rpa"])

MEDIA_MAX_BYTES = 20 * 1024 * 1024  # 20MB
MEDIA_MIME_PREFIXES = ("image/", "audio/")


# ============ 鉴权 ============

async def rpa_key_dep(x_rpa_key: str = Header(default="")) -> None:
    """Worker 接口鉴权：X-Rpa-Key 头比对 RPA_API_KEY（未配置则 RPA 通道整体不可用）。"""
    if not settings.rpa_api_key:
        raise HTTPException(503, "RPA 通道未启用（后端未配置 RPA_API_KEY）")
    if not x_rpa_key or not hmac.compare_digest(x_rpa_key, settings.rpa_api_key):
        raise HTTPException(401, "RPA key 无效")


# ============ 身份映射 ============

def resolve_identity(db: Session, account: str, platform: str, nickname: str,
                     prev_nickname: str = "") -> str:
    """昵称 → 稳定内部 ID。同昵称复用；prev_nickname 命中时迁移映射（改昵称不断会话）。"""
    nickname = nickname or "未知用户"
    row = (
        db.query(RpaIdentityMap)
        .filter(RpaIdentityMap.account == account, RpaIdentityMap.platform == platform,
                RpaIdentityMap.nickname == nickname)
        .first()
    )
    if row is not None:
        row.last_seen_at = datetime.utcnow()
        db.commit()
        return row.stable_user_id

    if prev_nickname:
        old = (
            db.query(RpaIdentityMap)
            .filter(RpaIdentityMap.account == account, RpaIdentityMap.platform == platform,
                    RpaIdentityMap.nickname == prev_nickname)
            .first()
        )
        if old is not None:
            stable = old.stable_user_id
            old.nickname = nickname  # 迁移到新昵称
            old.last_seen_at = datetime.utcnow()
            db.commit()
            logger.info("RPA 身份迁移 account=%s %s → %s (%s)", account, prev_nickname, nickname, stable)
            return stable

    stable = f"rpa_{account}_{uuid.uuid4().hex[:10]}"
    db.add(RpaIdentityMap(account=account, platform=platform, nickname=nickname,
                          stable_user_id=stable))
    db.commit()
    return stable


# ============ 入站 ============

@router.post("/incoming")
def rpa_incoming(req: RpaIncoming, db: Session = Depends(get_db),
                 _: None = Depends(rpa_key_dep)):
    """Worker 上报入站消息。身份解析后入队，复用现有幂等/合规/AI 链路。"""
    stable_user_id = resolve_identity(db, req.account, req.platform, req.nickname,
                                      req.prev_nickname)
    msg_id = req.msg_id or f"rpa_{uuid.uuid4().hex[:16]}"
    conv_id = req.conversation_id or f"conv_{stable_user_id}"
    payload = {
        "channel": "rpa",
        "account": req.account,
        "platform": req.platform,
        "user_id": stable_user_id,
        "nickname": req.nickname,
        "content": req.content,
        "msg_type": req.msg_type,
        "media_id": req.media_id,
        "msg_id": msg_id,
        "conversation_id": conv_id,
        "sender_side": req.sender_side,
    }
    enqueue("inbound_message", payload)
    return {"ok": True, "user_id": stable_user_id}


@router.post("/incoming_comment")
def rpa_incoming_comment(req: RpaIncomingComment, _: None = Depends(rpa_key_dep)):
    """Worker 上报作品评论：入队评论引擎（幂等由 platform_comment_id 唯一索引保证）。"""
    if not req.comment_id.strip():
        raise HTTPException(400, "comment_id 不能为空（幂等键）")
    enqueue("inbound_comment", {
        "platform": req.platform,
        "platform_post_id": req.platform_post_id,
        "post_url": req.post_url,
        "platform_comment_id": req.comment_id.strip(),
        "parent_comment_id": req.parent_comment_id,
        "author_id": req.author_id,
        "author_nickname": req.author_nickname,
        "content": req.content,
    })
    return {"ok": True}


# ============ 媒体上下行 ============

def _save_media(db: Session, file: UploadFile, kind: str) -> RpaMedia:
    mime = file.content_type or "application/octet-stream"
    if not mime.startswith(MEDIA_MIME_PREFIXES):
        raise HTTPException(400, f"不支持的媒体类型: {mime}")
    media_id = uuid.uuid4().hex
    ext = os.path.splitext(file.filename or "")[1][:10] or ".bin"
    dir_path = os.path.join(settings.upload_dir, "rpa")
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, f"{media_id}{ext}")
    data = file.file.read(MEDIA_MAX_BYTES + 1)
    if len(data) > MEDIA_MAX_BYTES:
        raise HTTPException(413, "媒体文件超过 20MB 限制")
    with open(path, "wb") as f:
        f.write(data)
    row = RpaMedia(id=media_id, kind=kind if kind in ("image", "voice") else "image",
                   path=path, mime=mime, size=len(data))
    db.add(row)
    db.commit()
    return row


@router.post("/media")
def rpa_upload_media(file: UploadFile, kind: str = "image", db: Session = Depends(get_db),
                     _: None = Depends(rpa_key_dep)):
    """Worker 上传媒体（用户发来的图片/语音）。"""
    row = _save_media(db, file, kind)
    return {"media_id": row.id}


@router.get("/media/{media_id}")
def rpa_download_media(media_id: str, db: Session = Depends(get_db),
                       _: None = Depends(rpa_key_dep)):
    """Worker 下载待发媒体（outbox 中的图片/语音）。"""
    row = db.get(RpaMedia, media_id)
    if row is None or not os.path.exists(row.path):
        raise HTTPException(404, "媒体不存在")
    return FileResponse(row.path, media_type=row.mime)


@router.get("/material/{material_id}")
def rpa_download_material(material_id: int, db: Session = Depends(get_db),
                          _: None = Depends(rpa_key_dep)):
    """Worker 下载内容素材（发布任务的图片/视频，对应 materials 表）。"""
    from ..models import Material
    row = db.get(Material, material_id)
    if row is None or not os.path.exists(row.path):
        raise HTTPException(404, "素材不存在")
    return FileResponse(row.path, media_type=row.mime)


# ============ 出站（outbox 拉取 + 回执） ============

def _reap_expired_leases(db: Session):
    """租约超时未 ack 的消息回滚为 pending（防 Worker 崩溃丢消息）。"""
    cutoff = datetime.utcnow() - timedelta(seconds=settings.rpa_outbox_lease_seconds)
    expired = (
        db.query(RpaOutbox)
        .filter(RpaOutbox.status == "leased", RpaOutbox.leased_at < cutoff)
        .all()
    )
    for row in expired:
        row.status = "pending"
        row.worker_id = ""
    if expired:
        db.commit()


@router.get("/outbox")
def pull_outbox(worker_id: str, account: str, limit: int = 5, db: Session = Depends(get_db),
                _: None = Depends(rpa_key_dep)):
    """Worker 拉取待发消息：按 account 隔离，按创建时间排序（同会话消息按序）。"""
    _reap_expired_leases(db)
    limit = max(1, min(limit, 20))
    rows = (
        db.query(RpaOutbox)
        .filter(RpaOutbox.status == "pending", RpaOutbox.account == account)
        .order_by(RpaOutbox.created_at, RpaOutbox.id)
        .limit(limit)
        .all()
    )
    now = datetime.utcnow()
    for row in rows:
        row.status = "leased"
        row.worker_id = worker_id
        row.leased_at = now
        row.attempts += 1
    db.commit()
    return {"messages": [
        {
            "outbox_id": r.id,
            "conversation_id": r.platform_conversation_id,
            "user_id": r.platform_user_id,
            "content": r.content,
            "msg_type": r.msg_type,
            "media_id": r.media_id,
        } for r in rows
    ]}


@router.post("/ack")
def ack_outbox(req: RpaAck, db: Session = Depends(get_db), _: None = Depends(rpa_key_dep)):
    """Worker 发送回执。失败累计 3 次置 failed 并告警。"""
    row = db.get(RpaOutbox, req.outbox_id)
    if row is None:
        raise HTTPException(404, "outbox 记录不存在")
    if req.ok:
        row.status = "acked"
        row.acked_at = datetime.utcnow()
        row.error = ""
        row.result = (req.platform_msg_id or "")[:512]  # 发布类任务回传笔记 URL 等
    else:
        row.error = req.error[:500]
        if row.attempts >= 3:
            row.status = "failed"
            monitor.record("rpa_send_failure",
                           f"outbox_id={row.id} account={row.account} error={row.error[:100]}")
            logger.error("RPA 发送最终失败 outbox_id=%s error=%s", row.id, row.error)
        else:
            row.status = "pending"  # 回滚重试
    db.commit()
    return {"ok": True, "status": row.status}


# ============ outbox 失败处置（工作台侧，JWT 鉴权） ============

@router.get("/outbox/failed")
def list_failed_outbox(account: str = "", db: Session = Depends(get_db),
                       _: Agent = Depends(get_current_agent)):
    """失败消息列表（设置页 RPA 卡片展示，可按 account 过滤，最近 100 条）。"""
    q = db.query(RpaOutbox).filter(RpaOutbox.status == "failed")
    if account:
        q = q.filter(RpaOutbox.account == account)
    rows = q.order_by(RpaOutbox.id.desc()).limit(100).all()
    return {"items": [
        {
            "outbox_id": r.id,
            "account": r.account,
            "platform": r.platform,
            "conversation_id": r.platform_conversation_id,
            "content": r.content[:100],
            "msg_type": r.msg_type,
            "attempts": r.attempts,
            "error": r.error,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows
    ]}


@router.post("/outbox/{outbox_id}/retry")
def retry_outbox(outbox_id: int, db: Session = Depends(get_db),
                 agent: Agent = Depends(get_current_agent)):
    """失败消息重发：置回 pending、清零重试计数，Worker 下轮即可拉到。"""
    row = db.get(RpaOutbox, outbox_id)
    if row is None:
        raise HTTPException(404, "outbox 记录不存在")
    if row.status != "failed":
        raise HTTPException(400, f"仅 failed 状态可重发（当前 {row.status}）")
    row.status = "pending"
    row.attempts = 0
    row.error = ""
    row.worker_id = ""
    row.leased_at = None
    db.commit()
    logger.info("outbox %s 人工重发（account=%s）", outbox_id, row.account)
    audit.log(db, agent, "rpa_outbox_retry", target=f"outbox:{outbox_id}",
              detail=row.content[:80])
    return {"ok": True, "status": row.status}


@router.post("/outbox/{outbox_id}/discard")
def discard_outbox(outbox_id: int, db: Session = Depends(get_db),
                   agent: Agent = Depends(get_current_agent)):
    """失败消息忽略：置 discarded（不再计入 failed，不再被拉取）。"""
    row = db.get(RpaOutbox, outbox_id)
    if row is None:
        raise HTTPException(404, "outbox 记录不存在")
    if row.status != "failed":
        raise HTTPException(400, f"仅 failed 状态可忽略（当前 {row.status}）")
    row.status = "discarded"
    db.commit()
    logger.info("outbox %s 人工忽略（account=%s）", outbox_id, row.account)
    audit.log(db, agent, "rpa_outbox_discard", target=f"outbox:{outbox_id}",
              detail=row.content[:80])
    return {"ok": True, "status": row.status}


# ============ 心跳 ============

@router.post("/heartbeat")
def heartbeat(req: RpaHeartbeat, db: Session = Depends(get_db), _: None = Depends(rpa_key_dep)):
    """Worker 心跳：登记/刷新状态（online | login_expired | selector_mismatch）。

    dry_run=True 时仅校验 key（依赖已完成），不落库不告警 —— 供 doctor 自检使用，
    避免自检把 worker 误标 online 后又被 sweeper 判 offline 产生告警噪音。
    """
    if req.dry_run:
        return {"ok": True, "dry_run": True}
    worker = db.query(RpaWorker).filter(RpaWorker.worker_id == req.worker_id).first()
    if worker is None:
        worker = RpaWorker(worker_id=req.worker_id, account=req.account, platform=req.platform)
        db.add(worker)
    worker.account = req.account
    worker.platform = req.platform
    worker.status = req.status if req.status in ("online", "login_expired", "selector_mismatch") else "online"
    worker.meta = req.meta or {}
    worker.last_heartbeat_at = datetime.utcnow()
    db.commit()
    if worker.status != "online":
        monitor.record(f"rpa_worker_{worker.status}", f"worker={req.worker_id} account={req.account}")
    return {"ok": True}


# ============ 身份解析（Worker 本地缓存用） ============

@router.post("/identity/resolve")
def identity_resolve(req: RpaIdentityResolve, db: Session = Depends(get_db),
                     _: None = Depends(rpa_key_dep)):
    stable = resolve_identity(db, req.account, req.platform, req.nickname, req.prev_nickname)
    return {"stable_user_id": stable}


# ============ 管理接口（JWT，前端状态卡片） ============

@router.get("/workers", response_model=list[RpaWorkerOut])
def list_workers(agent: Agent = Depends(get_current_agent), db: Session = Depends(get_db)):
    """RPA Worker 状态列表（按 account 分组展示用）。"""
    workers = db.query(RpaWorker).order_by(RpaWorker.account, RpaWorker.worker_id).all()
    result = []
    for w in workers:
        pending = db.query(RpaOutbox).filter(
            RpaOutbox.account == w.account, RpaOutbox.status.in_(["pending", "leased"])).count()
        failed = db.query(RpaOutbox).filter(
            RpaOutbox.account == w.account, RpaOutbox.status == "failed").count()
        result.append(RpaWorkerOut(
            worker_id=w.worker_id, account=w.account, platform=w.platform,
            status=w.status, meta=w.meta or {}, last_heartbeat_at=w.last_heartbeat_at,
            pending=pending, failed=failed,
        ))
    return result
