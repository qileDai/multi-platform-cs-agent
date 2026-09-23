"""客服工作台：分配上限、回头客、RAG 未命中硬转人工。"""
import uuid

import pytest

from app.agent import engine, router
from app.core.security import hash_password
from app.models import Agent, Conversation, Customer, Message, MissedQuestion
from app.rag import pipeline as rag_pipeline


def _agent(db, *, status="active", max_concurrent=20, name="客服"):
    a = Agent(
        username=f"a_{uuid.uuid4().hex[:8]}",
        password_hash=hash_password("x"),
        display_name=name,
        role="agent",
        status=status,
        max_concurrent=max_concurrent,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def test_auto_assign_least_load(db, conversation):
    db.query(Agent).update({Agent.status: "offline"})
    db.commit()
    busy = _agent(db, name="忙")
    idle = _agent(db, name="闲")
    other = Conversation(customer_id=conversation.customer_id, platform="mock",
                         mode="human", status="open", assignee_id=busy.id)
    db.add(other)
    conversation.mode = "pending"
    db.commit()

    assigned = router.auto_assign(db, conversation.id)
    db.commit()
    assert assigned == idle.id
    db.refresh(conversation)
    assert conversation.mode == "human"
    assert conversation.assignee_id == idle.id


def test_auto_assign_respects_capacity(db, conversation):
    db.query(Agent).update({Agent.status: "offline"})
    db.commit()
    full = _agent(db, max_concurrent=1, name="满")
    other = Conversation(customer_id=conversation.customer_id, platform="mock",
                         mode="human", status="open", assignee_id=full.id)
    db.add(other)
    conversation.mode = "pending"
    conversation.assignee_id = None
    db.commit()

    assigned = router.auto_assign(db, conversation.id)
    assert assigned is None
    db.refresh(conversation)
    assert conversation.mode == "pending"


def test_auto_assign_returning_customer(db, conversation):
    db.query(Agent).update({Agent.status: "offline"})
    db.commit()
    last = _agent(db, name="旧人")
    newbie = _agent(db, name="新人")
    closed = Conversation(
        customer_id=conversation.customer_id, platform="mock",
        mode="human", status="closed", assignee_id=last.id,
    )
    db.add(closed)
    conversation.mode = "pending"
    conversation.assignee_id = None
    db.commit()

    assigned = router.auto_assign(db, conversation.id)
    assert assigned == last.id
    assert assigned != newbie.id


@pytest.mark.asyncio
async def test_rag_miss_hard_handoff(db, conversation, monkeypatch):
    db.add(Message(conversation_id=conversation.id, sender_type="user",
                   msg_type="text", content="火星移民政策"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3):
        return rag_pipeline.RetrievalResult(passed=False, contexts=[])

    llm_called = []

    async def fake_llm(*_a, **_k):
        llm_called.append(1)
        raise AssertionError("未过阈值不应调用 LLM")

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id)
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")
    assert not llm_called
    missed = db.query(MissedQuestion).filter(MissedQuestion.conversation_id == conversation.id).first()
    assert missed is not None
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").first()
    assert ai is not None
    assert "转给同事" in ai.content


@pytest.mark.asyncio
async def test_ai_send_stopped_when_taken_over(db, conversation, monkeypatch):
    """生成过程中切到人工后，后续 AI 气泡不再发出。"""
    from app.database import SessionLocal
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user",
                   msg_type="text", content="多少钱"))
    db.commit()

    async def flip_mode(query, history=None, top_k=3):
        session = SessionLocal()
        try:
            conv = session.get(Conversation, conversation.id)
            conv.mode = "human"
            session.commit()
        finally:
            session.close()
        return rag_pipeline.RetrievalResult(
            passed=True, contexts=[{"content": "99 元", "source": "价格", "doc_id": 1}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["标准款 99"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", flip_mode)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id)
    db.rollback()
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).count()
    assert ai == 0
    db.refresh(conversation)
    assert conversation.mode == "human"


@pytest.mark.asyncio
async def test_agent_reply_reloads_after_send(db, conversation):
    """人工回复在另一个会话里提交后，接口按消息 id 重新读取，不再 refresh 已关闭对象。"""
    from app.api.conversations import agent_reply
    from app.core.security import hash_password
    from app.models import Agent
    from app.schemas import AgentMessageSend

    agent = Agent(
        username=f"reply_{uuid.uuid4().hex[:8]}",
        password_hash=hash_password("x"),
        display_name="客服",
        role="agent",
        status="active",
    )
    db.add(agent)
    conversation.mode = "human"
    db.commit()
    db.refresh(agent)
    db.get(Conversation, conversation.id)

    msg = await agent_reply(
        conversation.id, AgentMessageSend(content="您好，我来处理"), agent, db,
    )
    assert msg.id
    assert msg.sender_type == "agent"
    assert "您好" in msg.content
