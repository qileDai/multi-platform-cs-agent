"""上下文窗口管理：最近 N 条原文 + 更早历史的 LLM 滚动小结，控制 token 成本。"""
import logging

from openai import AsyncOpenAI

from ..config import settings
from ..database import SessionLocal
from ..models import Conversation, Message

logger = logging.getLogger(__name__)

RECENT_WINDOW = 10       # 注入提示词的最近原文条数
SUMMARY_INTERVAL = 20    # 每积累这么多条历史就增量更新一次小结

SUMMARY_PROMPT = """把下面的客服对话历史压缩成 100 字以内的小结，保留：用户需求、已给出的关键信息（价格/政策）、用户情绪和待办事项。只输出小结文本。

已有小结：{existing_summary}

新增对话：
{new_messages}"""


def get_history_for_prompt(conversation_id: int) -> tuple[str, list[dict]]:
    """返回 (注入提示词的历史文本, 最近消息列表[供查询改写用])。"""
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None:
            return "", []
        messages = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id, Message.is_internal == False)  # noqa: E712
            .order_by(Message.id)
            .all()
        )
        recent = messages[-RECENT_WINDOW:]
        lines = []
        if conversation.summary:
            lines.append(f"【早前对话小结】{conversation.summary}")
        for m in recent:
            role = {"user": "用户", "ai": "客服阿茶", "agent": "人工客服", "system": "系统"}.get(m.sender_type, m.sender_type)
            lines.append(f"{role}: {m.content}")
        recent_dicts = [{"sender_type": m.sender_type, "content": m.content} for m in recent]
        return "\n".join(lines), recent_dicts
    finally:
        db.close()


async def maybe_update_summary(conversation_id: int):
    """滚动小结：未压缩的消息积累超过阈值时，调 LLM 增量更新小结。"""
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or not settings.llm_configured:
            return
        new_messages = (
            db.query(Message)
            .filter(
                Message.conversation_id == conversation_id,
                Message.id > (conversation.summary_upto_message_id or 0),
                Message.is_internal == False,  # noqa: E712
            )
            .order_by(Message.id)
            .all()
        )
        if len(new_messages) < SUMMARY_INTERVAL:
            return

        to_compress = new_messages[:-RECENT_WINDOW]  # 保留最近原文，其余压缩
        if not to_compress:
            return
        text = "\n".join(
            f"{'用户' if m.sender_type == 'user' else '客服'}: {m.content}" for m in to_compress
        )
        try:
            client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
            resp = await client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": SUMMARY_PROMPT.format(
                    existing_summary=conversation.summary or "（无）", new_messages=text)}],
                temperature=0,
                max_tokens=300,
            )
            conversation.summary = resp.choices[0].message.content.strip()
            conversation.summary_upto_message_id = to_compress[-1].id
            db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("会话小结更新失败 conversation_id=%s", conversation_id)
    finally:
        db.close()
