"""会话服务中枢：入站消息处理、出站发送（守卫+频控）、转人工、广播。

这是连接 适配器 / 队列 / Agent 引擎 / WebSocket 的业务核心。
"""
import logging
from datetime import datetime
from typing import Any

from sqlalchemy.exc import IntegrityError

from .adapters import get_adapter, get_rpa_fallback_adapter, get_send_adapter, send_channel
from .api.ws import manager
from .config import settings
from .core import contentfilter, idempotency, monitor, ratelimit
from .core.queue import register_handler
from .database import SessionLocal
from .models import Conversation, Customer, HandoffEvent, Message, MissedQuestion
from .schemas import InboundMessage

logger = logging.getLogger(__name__)


# ============ 入站 ============

async def handle_inbound(payload: dict[str, Any]):
    """队列 worker 消费入口：normalize → 幂等 → 入库 → 广播 → AI 接待。"""
    # 按通道选适配器：mock 通道（模拟面板）强制走 MockAdapter，
    # 其 normalize 会读取 payload["platform"] 作为会话的展示平台标识；
    # 真实平台 webhook 不带 channel 字段，按 platform 正常路由
    channel = payload.get("channel") or payload.get("platform", "mock")
    adapter = get_adapter(channel)
    msg = await adapter.normalize(payload)
    if msg is None:
        logger.info(
            "入站事件被适配器忽略 channel=%s platform=%s payload_keys=%s",
            channel, payload.get("platform"), sorted(payload.keys()),
        )
        return

    # 幂等：平台重推直接丢弃
    event_key = f"{msg.platform}:{msg.platform_msg_id}" if msg.platform_msg_id else ""
    if event_key and idempotency.is_duplicate(event_key):
        return

    db = SessionLocal()
    try:
        customer = _upsert_customer(db, msg)
        conversation = _get_or_create_conversation(db, customer, msg)

        # 暗号钩子：用户私信命中评论规则的暗号 → 打标 + 漏斗归因（不阻断后续 AI 流程）
        if msg.sender_side != "agent" and msg.content:
            _apply_guide_code_hook(db, customer, msg)

        # 人工旁路消息（客服在平台后台直接发送，RPA Worker 同步）：入库保持消息流完整，
        # 不触发 AI、不计未读、不做内容过滤
        if msg.sender_side == "agent":
            message = _save_message(
                db, conversation.id, sender_type="agent", msg_type=msg.msg_type,
                content=msg.content, platform_msg_id=msg.platform_msg_id or None,
                extra={"bypass": True, **({"media_id": msg.media_id} if msg.media_id else {})},
            )
            conversation.last_message_at = message.created_at
            db.commit()
            await _broadcast_message(conversation, message)
            return

        # 媒体消息 → 文本替身：语音走 ASR 转写，图片走视觉描述；未配置/失败用占位文本
        media_extra: dict = {}
        if msg.msg_type == "voice" and msg.media_id:
            from .core import asr
            text = await asr.transcribe_media(msg.media_id)
            msg.content = text or "[语音消息]"
            media_extra = {"media_id": msg.media_id, "asr": bool(text)}
        elif msg.msg_type == "image" and msg.media_id:
            from .core import asr
            desc = await asr.describe_media(msg.media_id)
            msg.content = f"[图片] {desc}" if desc else "[图片消息]"
            media_extra = {"media_id": msg.media_id, "vision": bool(desc)}

        message = _save_message(
            db, conversation.id, sender_type="user", msg_type=msg.msg_type,
            content=msg.content, platform_msg_id=msg.platform_msg_id or None,
            extra=media_extra,
        )

        # 入口内容安全分级：block 打标 + 转人工（AI 不回复）；warn 仅打标
        # 媒体消息的替身文本（转写/描述）同样参与过滤
        risk = contentfilter.check_inbound(msg.content) if msg.content else {"level": "ok", "hit": []}
        if risk["level"] != "ok":
            message.extra = {**(message.extra or {}), "risk": risk["level"], "risk_hits": risk["hit"]}
            logger.warning("入口风险消息 level=%s hits=%s content=%s",
                           risk["level"], risk["hit"], contentfilter.mask_lead(msg.content))

        conversation.last_message_at = message.created_at
        conversation.unread_count = (conversation.unread_count or 0) + 1
        db.commit()

        await _broadcast_message(conversation, message)

        if risk["level"] == "block":
            # 严重违规：AI 不回复，直接转人工（系统提示语由 handoff 生成）
            await handoff(conversation.id, reason="risk_content")
            return

        # AI 全局熔断：开关关闭时所有 AI 会话直接转人工，不调用 LLM
        if not settings.ai_globally_enabled and conversation.mode == "ai":
            logger.warning("AI 全局开关已关闭，会话 %s 直接转人工", conversation.id)
            await handoff(conversation.id, reason="ai_globally_disabled")
            return

        # AI 接待模式才进 Agent 引擎
        if conversation.mode == "ai" and conversation.status == "open":
            # 通知前端展示「正在输入」动画（AI 回复的 new_message 到达后前端自动清除）
            await manager.broadcast("ai_typing", {"conversation_id": conversation.id})
            from .agent.engine import process_ai_reply  # 延迟导入避免循环依赖
            await process_ai_reply(conversation.id)
    finally:
        db.close()


def _upsert_customer(db, msg: InboundMessage) -> Customer:
    customer = (
        db.query(Customer)
        .filter(Customer.platform == msg.platform, Customer.platform_user_id == msg.platform_user_id)
        .first()
    )
    if customer is None:
        customer = Customer(
            platform=msg.platform,
            platform_user_id=msg.platform_user_id,
            nickname=msg.nickname or f"用户{msg.platform_user_id[-4:]}",
            avatar=msg.avatar,
            tags=[],
        )
        db.add(customer)
        db.flush()
    else:
        # 更新资料（平台侧昵称头像可能变化）
        if msg.nickname:
            customer.nickname = msg.nickname
        if msg.avatar:
            customer.avatar = msg.avatar
        customer.updated_at = datetime.utcnow()
    return customer


def _get_or_create_conversation(db, customer: Customer, msg: InboundMessage) -> Conversation:
    conversation = (
        db.query(Conversation)
        .filter(Conversation.customer_id == customer.id, Conversation.status == "open")
        .order_by(Conversation.id.desc())
        .first()
    )
    if conversation is None:
        conversation = Conversation(
            customer_id=customer.id,
            platform=msg.platform,
            platform_conversation_id=msg.platform_conversation_id,
            mode="ai",
            status="open",
        )
        db.add(conversation)
        db.flush()
    elif msg.platform_conversation_id and not conversation.platform_conversation_id:
        conversation.platform_conversation_id = msg.platform_conversation_id
    return conversation


def _save_message(db, conversation_id: int, *, sender_type: str, content: str,
                  msg_type: str = "text", sender_id: int | None = None,
                  platform_msg_id: str | None = None, extra: dict | None = None,
                  is_internal: bool = False) -> Message:
    message = Message(
        conversation_id=conversation_id,
        sender_type=sender_type,
        sender_id=sender_id,
        msg_type=msg_type,
        content=content,
        platform_msg_id=platform_msg_id,
        extra=extra or {},
        is_internal=is_internal,
    )
    db.add(message)
    try:
        db.flush()
    except IntegrityError:
        # platform_msg_id 唯一冲突 = 重复消息，回滚后查已有
        db.rollback()
        existing = db.query(Message).filter(Message.platform_msg_id == platform_msg_id).first()
        if existing:
            return existing
        raise
    return message


# ============ 出站（守卫 + 频控 + 发送 + 入库 + 广播） ============

async def send_outbound(conversation_id: int, content: str, *, sender_type: str,
                        sender_id: int | None = None, extra: dict | None = None,
                        skip_filter: bool = False, msg_type: str = "text",
                        media_id: str = "") -> Message | None:
    """统一出站入口。返回 None 表示被守卫/频控拦截。

    msg_type/media_id：图片/语音消息（RPA 通道经 outbox 由 Worker 发到平台）。
    """
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None:
            return None
        customer = db.get(Customer, conversation.customer_id)

        # 1. 出口违禁词过滤
        filtered = content
        if not skip_filter:
            filtered, hits = contentfilter.sanitize(content)
            if hits:
                logger.warning("违禁词命中 %s，已改写: %s", hits, contentfilter.mask_lead(content))
                extra = {**(extra or {}), "filtered_words": hits}

        # 2. 平台频控（RPA 通道适用更严的专属规则，键为 <platform>_rpa；
        #    抖音企业号账号形态走 douyin_enterprise_rpa，官方规则与抖店不同）
        conv_key = conversation.platform_conversation_id or str(conversation.id)
        rate_platform = conversation.platform
        if send_channel(conversation.platform) == "rpa":
            rate_platform = f"{conversation.platform}_rpa"
            if (conversation.platform == "douyin"
                    and settings.douyin_account_type == "enterprise"):
                rate_platform = "douyin_enterprise_rpa"
        allowed, rule = ratelimit.check_and_count(rate_platform, conv_key)
        if not allowed:
            logger.warning("频控超限 platform=%s rule=%s，转人工", rate_platform, rule)
            await handoff(conversation_id, reason=f"rate_limit:{rule}")
            return None

        # 3. 平台发送（官方 API 或 RPA outbox，按通道配置路由）；
        #    API 通道失败且 RPA 已配置时自动降级 RPA 兜底（消息不丢，运维告警）
        adapter = get_send_adapter(conversation.platform)
        try:
            platform_msg_id = await adapter.send(
                conversation.platform_conversation_id, customer.platform_user_id, filtered,
                msg_type=msg_type, media_id=media_id,
            )
        except Exception as exc:  # noqa: BLE001
            fallback = get_rpa_fallback_adapter(conversation.platform)
            if fallback is None:
                raise
            logger.exception("[API 发送失败→RPA 降级] platform=%s conv=%s err=%s",
                             conversation.platform, conversation.platform_conversation_id, exc)
            monitor.record("api_send_fallback",
                           f"platform={conversation.platform} err={str(exc)[:150]}")
            platform_msg_id = await fallback.send(
                conversation.platform_conversation_id, customer.platform_user_id, filtered,
                msg_type=msg_type, media_id=media_id,
            )
            extra = {**(extra or {}), "send_fallback": "rpa", "api_error": str(exc)[:200]}

        # 4. 入库 + 广播
        if media_id:
            extra = {**(extra or {}), "media_id": media_id}
        message = _save_message(
            db, conversation_id, sender_type=sender_type, content=filtered,
            msg_type=msg_type, sender_id=sender_id, platform_msg_id=platform_msg_id,
            extra=extra,
        )
        conversation.last_message_at = message.created_at
        db.commit()
        await _broadcast_message(conversation, message)
        return message
    finally:
        db.close()


# ============ 转人工 / 模式切换 ============

async def handoff(conversation_id: int, reason: str, db=None):
    """会话切到 pending（排队待人工），记录事件，自动分配客服，广播提醒。"""
    own_db = db is None
    db = db or SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or conversation.mode != "ai":
            return
        conversation.mode = "pending"
        db.add(HandoffEvent(conversation_id=conversation_id, reason=reason, from_mode="ai"))

        sys_msg = _save_message(
            db, conversation_id, sender_type="system", msg_type="system",
            content=f"已为您转接人工客服，请稍等哈~（原因：{reason}）",
        )
        conversation.last_message_at = sys_msg.created_at
        db.commit()

        # 自动分配（按空闲度轮转）
        from .agent.router import auto_assign
        auto_assign(db, conversation_id)
        db.commit()

        await _broadcast_message(conversation, sys_msg)
        await manager.broadcast("handoff", {"conversation_id": conversation_id, "reason": reason})
    finally:
        if own_db:
            db.close()


# ============ 未命中问题沉淀 ============

def record_missed_question(question: str, platform: str, conversation_id: int):
    db = SessionLocal()
    try:
        existing = (
            db.query(MissedQuestion)
            .filter(MissedQuestion.question == question, MissedQuestion.status == "pending")
            .first()
        )
        if existing:
            existing.count += 1
            existing.updated_at = datetime.utcnow()
        else:
            db.add(MissedQuestion(
                question=question[:500], platform=platform, conversation_id=conversation_id
            ))
        db.commit()
    finally:
        db.close()


# ============ 广播辅助 ============

async def _broadcast_message(conversation: Conversation, message: Message):
    await manager.broadcast("new_message", {
        "conversation_id": conversation.id,
        "platform": conversation.platform,
        "message": {
            "id": message.id,
            "conversation_id": message.conversation_id,
            "sender_type": message.sender_type,
            "sender_id": message.sender_id,
            "msg_type": message.msg_type,
            "content": message.content,
            "extra": message.extra or {},
            "is_internal": message.is_internal,
            "created_at": message.created_at.isoformat() if message.created_at else None,
        },
    })


def _apply_guide_code_hook(db, customer: Customer, msg: InboundMessage):
    """暗号钩子：私信内容命中启用中评论规则的 guide_code → 客户打标 + FunnelEvent(dm)。

    用于评论引流归因：评论自动回复引导用户私信暗号，此处识别暗号完成
    「评论 → 私信」链路的归因串联。不阻断后续 AI 接待流程。
    """
    from .models import CommentRule, FunnelEvent  # 延迟导入避免顶部膨胀
    rules = (db.query(CommentRule).filter(CommentRule.enabled.is_(True))
             .order_by(CommentRule.priority.desc(), CommentRule.id).all())
    for rule in rules:
        code = (rule.guide_code or "").strip()
        if not code or code not in msg.content:
            continue
        tags = list(customer.tags or [])
        tag = f"暗号:{code}"
        if tag not in tags:
            tags.append(tag)
            customer.tags = tags
        if not customer.source_guide_code:
            customer.source_guide_code = code
        db.add(FunnelEvent(stage="dm", platform=msg.platform, customer_id=customer.id,
                           guide_code=code))
        db.commit()
        logger.info("暗号命中 customer_id=%s code=%s", customer.id, code)
        return  # 一条消息只归因一个暗号（优先级最高的先命中）


# ============ 内容矩阵：队列任务处理器 ============

async def handle_content_generate(payload: dict[str, Any]):
    """队列任务：AI 生成平台版本（创作图：生成→合规→改写循环）。"""
    from .creator.graph import run_creator_graph  # 延迟导入避免循环依赖
    version = await run_creator_graph(
        item_id=int(payload["item_id"]),
        platform=payload["platform"],
        content_type=payload.get("content_type", "note"),
        variant_index=int(payload.get("variant_index", 0)),  # 一稿多版（Phase 7）
    )
    try:
        from .api.ws import manager
        await manager.broadcast("content_version_updated", {
            "item_id": int(payload["item_id"]),
            "version_id": version.id if version else 0,
            "platform": payload["platform"],
            "ok": version is not None,
        })
    except Exception:  # noqa: BLE001
        logger.exception("创作完成广播失败")


async def handle_compliance_check(payload: dict[str, Any]):
    """队列任务：版本合规手动复检。"""
    from .creator.compliance import check_version  # 延迟导入避免循环依赖
    version = await check_version(int(payload["version_id"]))
    try:
        from .api.ws import manager
        await manager.broadcast("content_version_updated", {
            "item_id": version.content_item_id if version else 0,
            "version_id": int(payload["version_id"]),
            "platform": version.platform if version else "",
            "ok": version is not None,
        })
    except Exception:  # noqa: BLE001
        logger.exception("复检完成广播失败")


# 注册队列处理器
register_handler("inbound_message", handle_inbound)
register_handler("content_generate", handle_content_generate)
register_handler("compliance_check", handle_compliance_check)
