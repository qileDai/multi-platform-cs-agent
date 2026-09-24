"""知你快回「自己的回复接口」。

插件把网页私信 POST 过来，本模块入库并在同一次请求里生成回复。
发送由插件完成，这里不调用平台适配器，也不写 RPA outbox。
"""
import hashlib
import hmac
import logging
from typing import Any

from sqlalchemy.exc import IntegrityError

from ..agent.engine import process_ai_reply
from ..config import settings
from ..core import contentfilter, ratelimit
from ..database import SessionLocal
from ..models import Conversation, Customer, Message
from ..schemas import InboundMessage
from ..services import _apply_guide_code_hook, _broadcast_message, handoff

logger = logging.getLogger(__name__)

REPLY_PATH = "/api/integrations/zhinikuaihui/reply"
CONNECTION_REPLY = "连接成功，可以开始回复。"
PLATFORM_MAP = {
    "douyin": "douyin",
    "xiaohongshu": "xiaohongshu",
    "xiaohongshu-sxt": "xiaohongshu",
}


def short_key(platform: str, kind: str, raw: str) -> str:
    """稳定 63 字符短键，放进 String(64) 唯一列。原文不直接入库，避免和开放平台消息 ID 撞车。"""
    digest = hashlib.sha256(f"{platform}\n{kind}\n{raw}".encode()).hexdigest()[:60]
    return f"zn:{digest}"


def check_api_key(authorization: str, x_api_key: str) -> dict | None:
    """密钥未配置返回 503 说明；不匹配返回 401。通过时返回 None。

    插件只读 JSON 的 message 字段，不能用 FastAPI 默认的 detail。
    """
    if not settings.zhini_reply_api_key:
        return {"status": 503, "body": {"message": "知你快回回复接口未启用（未配置 ZHINI_REPLY_API_KEY）"}}
    tokens = []
    header = (authorization or "").strip()
    if header.lower().startswith("bearer "):
        tokens.append(header[7:].strip())
    if x_api_key:
        tokens.append(x_api_key.strip())
    expected = settings.zhini_reply_api_key
    if any(token and hmac.compare_digest(token, expected) for token in tokens):
        return None
    return {"status": 401, "body": {"message": "接口密钥无效"}}


def is_connection_test(body: dict) -> bool:
    request_id = str(body.get("request_id") or "")
    return body.get("conversation_id") == "connection-test" or request_id.startswith("connection-test-")


async def handle_reply(body: dict) -> dict:
    """返回插件要求的 reply / skip 对象。生成失败也是 HTTP 200 的 skip，避免插件暂停自动回复。"""
    try:
        return await _handle_reply(body)
    except Exception:
        logger.exception("知你快回回复失败")
        return _skip("回复生成失败，请稍后在工作台处理")


async def _handle_reply(body: dict) -> dict:
    if is_connection_test(body):
        return {"action": "reply", "reply": CONNECTION_REPLY}

    raw_platform = str(body.get("platform") or "").strip()
    platform = PLATFORM_MAP.get(raw_platform)
    if platform is None:
        return _skip("该平台暂不支持")

    message = body.get("message") if isinstance(body.get("message"), dict) else {}
    text = str(message.get("text") or "").strip()
    direction = message.get("direction") or "incoming"
    if direction != "incoming" or not text:
        return _skip("没有需要回复的客户消息")

    request_id = str(body.get("request_id") or message.get("id") or "").strip()
    if not request_id:
        return _skip("缺少 request_id")
    request_key = short_key(raw_platform, "request", request_id)

    cached = _cached_reply(request_key)
    if cached:
        return {"action": "reply", "reply": cached[:4000]}

    conversation_id, mode, status, trigger_id = _persist(body, platform, raw_platform, request_key, text)
    if trigger_id is None:
        cached = _cached_reply(request_key)
        if cached:
            return {"action": "reply", "reply": cached[:4000]}
        return _skip("消息入库冲突，请稍后重试")

    await _broadcast_saved(conversation_id, trigger_id)

    if status != "open":
        return _skip("会话已结束")

    risk = contentfilter.check_inbound(text)
    if risk["level"] == "block":
        _mark_risk(trigger_id, risk)
        if mode == "ai":
            await handoff(conversation_id, reason="risk_content")
        return _skip("消息触发风险拦截，请人工处理")
    if risk["level"] == "warn":
        _mark_risk(trigger_id, risk)

    if not settings.ai_globally_enabled:
        if mode == "ai":
            await handoff(conversation_id, reason="ai_globally_disabled")
        return _skip("AI 已关闭，请人工回复")

    if mode not in ("ai", "pending", "human"):
        return _skip("会话已由人工接待")

    reply_text = await process_ai_reply(conversation_id, local=True, allow_owned=mode != "ai")
    reply_text = (reply_text or "").strip()[:4000]
    if not reply_text:
        return _skip("没有可发送的回复")
    return {"action": "reply", "reply": reply_text}


def _skip(reason: str) -> dict:
    return {"action": "skip", "reason": (reason or "不回复")[:500]}


def _cached_reply(request_key: str) -> str:
    db = SessionLocal()
    try:
        trigger = db.query(Message).filter(Message.platform_msg_id == request_key).first()
        if trigger is None:
            return ""
        reply = (
            db.query(Message)
            .filter(
                Message.conversation_id == trigger.conversation_id,
                Message.id > trigger.id,
                Message.sender_type == "ai",
                Message.is_internal.is_(False),
            )
            .order_by(Message.id.asc())
            .first()
        )
        return (reply.content or "").strip() if reply is not None else ""
    finally:
        db.close()


def _persist(body: dict, platform: str, raw_platform: str, request_key: str, text: str) -> tuple[int, str, str, int | None]:
    """写入客户、会话和消息。返回 (conversation_id, mode, status, trigger_message_id)。

    客户和会话先提交。消息单独提交，唯一冲突只回滚消息事务。
    """
    message = body.get("message") if isinstance(body.get("message"), dict) else {}
    customer_raw = str(body.get("customer_id") or message.get("sender_id") or body.get("conversation_id") or "unknown")
    customer_key = short_key(raw_platform, "customer", customer_raw)
    conversation_raw = str(body.get("conversation_id") or customer_raw)
    conversation_key = short_key(raw_platform, "conversation", conversation_raw)
    nickname = str(body.get("customer_nickname") or message.get("sender_name") or body.get("conversation_name") or "")[:64]
    request_id = str(body.get("request_id") or "")
    is_group = body.get("is_group") is True

    db = SessionLocal()
    try:
        customer = (
            db.query(Customer)
            .filter(Customer.platform == platform, Customer.platform_user_id == customer_key)
            .first()
        )
        if customer is None:
            customer = Customer(
                platform=platform,
                platform_user_id=customer_key,
                nickname=nickname or f"用户{customer_key[-4:]}",
                tags=[],
            )
            db.add(customer)
            db.flush()
        elif nickname:
            customer.nickname = nickname

        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.customer_id == customer.id,
                Conversation.platform_conversation_id == conversation_key,
                Conversation.status == "open",
            )
            .order_by(Conversation.id.desc())
            .first()
        )
        if conversation is None:
            conversation = Conversation(
                customer_id=customer.id,
                platform=platform,
                platform_conversation_id=conversation_key,
                mode="ai",
                status="open",
            )
            db.add(conversation)
            db.flush()

        _apply_guide_code_hook(db, customer, InboundMessage(
            platform=platform,
            platform_user_id=customer_key,
            platform_conversation_id=conversation_key,
            content=text,
            nickname=nickname,
        ))
        db.commit()
        conversation_id = conversation.id
        mode = conversation.mode
        status = conversation.status
    finally:
        db.close()

    history = body.get("messages") if isinstance(body.get("messages"), list) else []
    for item in history:
        if not isinstance(item, dict) or _same_trigger(item, message):
            continue
        item_text = str(item.get("text") or "").strip()
        if not item_text:
            continue
        item_direction = item.get("direction") or "incoming"
        item_id = str(item.get("id") or "").strip()
        if item_id:
            item_key = short_key(raw_platform, "message", item_id)
        else:
            item_key = short_key(
                raw_platform, "history",
                f"{conversation_key}\n{item_direction}\n{int(item.get('timestamp') or 0)}\n{item_text}",
            )
        _insert_message(
            conversation_id,
            sender_type="user" if item_direction == "incoming" else "agent",
            content=item_text[:4000],
            platform_msg_id=item_key,
            extra=_message_extra(body, raw_platform, item, request_id=""),
            unread=False,
        )

    trigger = _insert_message(
        conversation_id,
        sender_type="user",
        content=text[:4000],
        platform_msg_id=request_key,
        extra=_message_extra(body, raw_platform, message, request_id=request_id),
        unread=True,
    )
    if trigger is None:
        return conversation_id, mode, status, None

    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        mode = conversation.mode if conversation is not None else mode
        status = conversation.status if conversation is not None else status
        if conversation is not None:
            ratelimit.reset_reply_window(
                conversation.platform,
                conversation.platform_conversation_id or str(conversation.id),
            )
    finally:
        db.close()
    return conversation_id, mode, status, trigger


def _same_trigger(item: dict, trigger: dict) -> bool:
    item_id = str(item.get("id") or "").strip()
    trigger_id = str(trigger.get("id") or "").strip()
    if item_id and trigger_id and item_id == trigger_id:
        return True
    return (
        str(item.get("text") or "").strip() == str(trigger.get("text") or "").strip()
        and (item.get("direction") or "incoming") == (trigger.get("direction") or "incoming")
        and int(item.get("timestamp") or 0) == int(trigger.get("timestamp") or 0)
    )


def _message_extra(body: dict, raw_platform: str, message: dict, *, request_id: str) -> dict:
    extra: dict[str, Any] = {
        "channel": "zhinikuaihui",
        "plugin_platform": raw_platform,
        "zhini_conversation_id": str(body.get("conversation_id") or ""),
        "zhini_customer_id": str(body.get("customer_id") or ""),
        "zhini_message_id": str(message.get("id") or ""),
        "is_group": body.get("is_group") is True,
    }
    if request_id:
        extra["zhini_request_id"] = request_id
    return extra


def _insert_message(conversation_id: int, *, sender_type: str, content: str,
                    platform_msg_id: str, extra: dict, unread: bool) -> int | None:
    """插入一条消息。唯一冲突时不回滚其它已提交数据，返回已有或新建消息的 id。"""
    db = SessionLocal()
    try:
        existing = db.query(Message).filter(Message.platform_msg_id == platform_msg_id).first()
        if existing is not None:
            return existing.id
        message = Message(
            conversation_id=conversation_id,
            sender_type=sender_type,
            msg_type="text",
            content=content,
            platform_msg_id=platform_msg_id,
            extra=extra,
        )
        db.add(message)
        db.flush()
        if unread and sender_type == "user":
            conversation = db.get(Conversation, conversation_id)
            if conversation is not None:
                conversation.unread_count = (conversation.unread_count or 0) + 1
                conversation.last_message_at = message.created_at
        db.commit()
        return message.id
    except IntegrityError:
        db.rollback()
        existing = db.query(Message).filter(Message.platform_msg_id == platform_msg_id).first()
        return existing.id if existing is not None else None
    finally:
        db.close()


def _mark_risk(message_id: int, risk: dict) -> None:
    db = SessionLocal()
    try:
        message = db.get(Message, message_id)
        if message is None:
            return
        message.extra = {**(message.extra or {}), "risk": risk["level"], "risk_hits": risk["hit"]}
        db.commit()
    finally:
        db.close()


async def _broadcast_saved(conversation_id: int, message_id: int) -> None:
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        message = db.get(Message, message_id)
        if conversation is None or message is None:
            return
        await _broadcast_message(conversation, message)
    finally:
        db.close()
