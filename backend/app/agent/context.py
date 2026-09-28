"""上下文窗口管理：最近 N 条原文 + 更早历史的 LLM 滚动小结，控制 token 成本。"""
import logging

from openai import AsyncOpenAI

from ..config import settings
from ..database import SessionLocal
from ..models import Conversation, Customer, Message

logger = logging.getLogger(__name__)

RECENT_WINDOW = 10       # 注入提示词的最近原文条数
SUMMARY_MIN_NEW = 4      # 自上次小结以来至少这么多条，就重写一版覆盖全段的小结

SUMMARY_PROMPT = """把下面的客服对话历史压缩成 100 字以内的小结，保留：用户需求、已给出的关键信息（价格/政策）、用户情绪和待办事项。只输出小结文本。

已有小结：{existing_summary}

新增对话：
{new_messages}"""


def get_history_for_prompt(conversation_id: int) -> tuple[str, list[dict], str]:
    """返回 (注入提示词的历史文本, 最近消息列表[供查询改写用], 会话小结)。"""
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None:
            return "", [], ""
        messages = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id, Message.is_internal == False)  # noqa: E712
            .order_by(Message.id)
            .all()
        )
        recent = messages[-RECENT_WINDOW:]
        lines = []
        summary = conversation.summary or ""
        if summary:
            lines.append(f"【早前对话小结】{summary}")
        for m in recent:
            role = {"user": "用户", "ai": "客服阿茶", "agent": "人工客服", "system": "系统"}.get(m.sender_type, m.sender_type)
            lines.append(f"{role}: {m.content}")
        recent_dicts = [
            {
                "sender_type": m.sender_type,
                "content": m.content,
                "grounded": bool((m.extra or {}).get("grounded")),
            }
            for m in recent
        ]
        return "\n".join(lines), recent_dicts, summary
    finally:
        db.close()


def customer_profile_text(conversation_id: int) -> str:
    """同一客户的标签、留资，以及上一通已有小结。没有可用信息时返回「无」。"""
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None:
            return "无"
        customer = db.get(Customer, conversation.customer_id)
        previous = (
            db.query(Conversation)
            .filter(
                Conversation.customer_id == conversation.customer_id,
                Conversation.id != conversation.id,
                Conversation.summary != "",
            )
            .order_by(Conversation.id.desc())
            .first()
        )
        lines: list[str] = []
        tags = [tag for tag in list((customer.tags if customer else None) or []) if tag]
        if tags:
            lines.append("标签：" + "、".join(str(tag) for tag in tags))
        phone = (customer.lead_phone or "").strip() if customer else ""
        wechat = (customer.lead_wechat or "").strip() if customer else ""
        if phone:
            lines.append("手机号：" + phone)
        if wechat:
            lines.append("微信：" + wechat)
        if previous and (previous.summary or "").strip():
            lines.append("上一通小结：" + previous.summary.strip())
        return "\n".join(lines) if lines else "无"
    finally:
        db.close()


async def maybe_update_summary(conversation_id: int):
    """自上次小结以来满 4 条消息时，重写一版覆盖整段对话的短小结。"""
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or not settings.llm_configured:
            return
        pending = (
            db.query(Message)
            .filter(
                Message.conversation_id == conversation_id,
                Message.id > (conversation.summary_upto_message_id or 0),
                Message.is_internal == False,  # noqa: E712
            )
            .count()
        )
        if pending < SUMMARY_MIN_NEW:
            return
        messages = (
            db.query(Message)
            .filter(
                Message.conversation_id == conversation_id,
                Message.is_internal == False,  # noqa: E712
            )
            .order_by(Message.id)
            .all()
        )
        if not messages:
            return
        text = "\n".join(
            f"{'用户' if m.sender_type == 'user' else '客服'}: {m.content}" for m in messages
        )
        try:
            client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key, timeout=8.0)
            resp = await client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": SUMMARY_PROMPT.format(
                    existing_summary=conversation.summary or "（无）", new_messages=text)}],
                temperature=0,
                max_tokens=300,
            )
            conversation.summary = (resp.choices[0].message.content or "").strip()
            conversation.summary_upto_message_id = messages[-1].id
            db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("会话小结更新失败 conversation_id=%s", conversation_id)
    finally:
        db.close()
