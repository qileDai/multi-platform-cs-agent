"""客服工作台：分配上限、回头客、RAG 未命中硬转人工。"""
import uuid
from datetime import datetime, timedelta

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

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(passed=False, contexts=[])

    llm_called = []

    async def fake_llm(*_a, **_k):
        llm_called.append(1)
        from app.schemas import AgentReply
        return AgentReply(reply_messages=["我先让同事确认"], intent="other", confidence=0.2, handoff=True, handoff_reason="low_confidence")

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id)
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")
    assert llm_called
    missed = db.query(MissedQuestion).filter(MissedQuestion.conversation_id == conversation.id).first()
    assert missed is not None
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").first()
    assert ai is not None
    assert "确认" in ai.content


@pytest.mark.asyncio
async def test_ai_send_stopped_when_taken_over(db, conversation, monkeypatch):
    """生成过程中切到人工后，后续 AI 气泡不再发出。"""
    from app.database import SessionLocal
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user",
                   msg_type="text", content="多少钱"))
    db.commit()

    async def flip_mode(query, history=None, top_k=3, summary=""):
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


def test_bad_case_records_user_question(db, conversation):
    from app.api.messages import mark_bad_case
    from app.core.security import hash_password
    from app.models import Agent, MissedQuestion
    from app.schemas import BadCaseMark

    agent = Agent(
        username=f"bad_{uuid.uuid4().hex[:8]}",
        password_hash=hash_password("x"),
        display_name="客服",
        role="agent",
        status="active",
    )
    db.add(agent)
    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="能开发票吗"))
    db.flush()
    ai = Message(conversation_id=conversation.id, sender_type="ai", msg_type="text", content="可以的")
    db.add(ai)
    db.commit()

    mark_bad_case(ai.id, BadCaseMark(bad_case=True, note="答错了"), agent, db)
    missed = db.query(MissedQuestion).filter(MissedQuestion.question == "能开发票吗").one()
    assert missed.status == "pending"
    mark_bad_case(ai.id, BadCaseMark(bad_case=True, note="再记一次"), agent, db)
    db.expire_all()
    missed = db.query(MissedQuestion).filter(MissedQuestion.question == "能开发票吗").one()
    assert missed.count == 2


def _owned_conversation(db, conversation, content, mode="human"):
    conversation.mode = mode
    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content=content))
    db.commit()


@pytest.mark.asyncio
async def test_human_mode_hit_sends_reply(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    _owned_conversation(db, conversation, "面签资料清单")

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "面签资料清单：身份证", "source": "注册资料"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["带上身份证就行"], intent="consult_feature", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id, allow_owned=True)
    db.expire_all()
    db.refresh(conversation)
    assert conversation.mode == "human"
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "身份证" in ai.content


@pytest.mark.asyncio
async def test_human_mode_miss_leaves_note_and_reason(db, conversation, monkeypatch):
    _owned_conversation(db, conversation, "火星移民政策")

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(passed=False, reason="no_hits", rewritten_queries=[query])

    async def fake_llm(*_a, **_k):
        raise AssertionError("未命中不应生成")

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id, allow_owned=True)
    db.expire_all()
    db.refresh(conversation)
    assert conversation.mode == "human"
    user = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "user",
    ).one()
    assert user.extra["retrieval"]["reason"] == "no_hits"
    note = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "system",
    ).one()
    assert note.content == "这条没对上资料，需要人工回复"
    assert db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).count() == 0


@pytest.mark.asyncio
async def test_pure_greeting_stays_with_ai(db, conversation, monkeypatch):
    called = []

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        called.append(query)
        return rag_pipeline.RetrievalResult(passed=False, reason="no_hits")

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    for text in ("你好", "你好呀", "在吗？"):
        db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content=text))
        db.commit()
        await engine.process_ai_reply(conversation.id)
        db.expire_all()
        db.refresh(conversation)
        assert conversation.mode == "ai"
        ai = (
            db.query(Message)
            .filter(Message.conversation_id == conversation.id, Message.sender_type == "ai")
            .order_by(Message.id.desc())
            .first()
        )
        assert "没查到靠谱资料" not in ai.content
        assert "小赢" in ai.content
        assert "开户" in ai.content
    assert called == []
    assert db.query(MissedQuestion).filter(MissedQuestion.conversation_id == conversation.id).count() == 0
    assert db.query(Message).filter(
        Message.conversation_id == conversation.id,
        Message.content == "这条没对上资料，需要人工回复",
    ).count() == 0


@pytest.mark.asyncio
async def test_greeting_plus_question_still_retrieves(db, conversation, monkeypatch):
    seen = []

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        seen.append(query)
        return rag_pipeline.RetrievalResult(passed=False, reason="no_hits", rewritten_queries=[query])

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text",
        content="你好，面签资料清单",
    ))
    db.commit()
    await engine.process_ai_reply(conversation.id)
    assert seen == ["你好，面签资料清单"]


@pytest.mark.asyncio
async def test_human_greeting_sends_without_mode_change(db, conversation, monkeypatch):
    _owned_conversation(db, conversation, "你好")
    await engine.process_ai_reply(conversation.id, allow_owned=True)
    db.expire_all()
    db.refresh(conversation)
    assert conversation.mode == "human"
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "小赢" in ai.content
    assert "开户" in ai.content
    assert db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "system",
    ).count() == 0


@pytest.mark.asyncio
async def test_empty_model_reply_hands_off(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="怎么办理"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "办理说明", "source": "资料"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=[], handoff=False)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "确认" in ai.content


@pytest.mark.asyncio
async def test_replay_only_unanswered_phrase(db, conversation, monkeypatch):
    from app import services
    from app.schemas import AgentReply

    customer_id = conversation.customer_id
    conversation.mode = "human"
    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text", content="面签资料清单",
    ))
    answered = Conversation(
        customer_id=customer_id, platform="mock", mode="human", status="open",
        platform_conversation_id=f"done_{uuid.uuid4().hex[:8]}",
    )
    greeting = Conversation(
        customer_id=customer_id, platform="mock", mode="ai", status="open",
        platform_conversation_id=f"hi_{uuid.uuid4().hex[:8]}",
    )
    db.add_all([answered, greeting])
    db.flush()
    db.add(Message(conversation_id=answered.id, sender_type="user", msg_type="text", content="面签资料清单"))
    db.flush()
    db.add(Message(conversation_id=answered.id, sender_type="ai", msg_type="text", content="已经回过"))
    db.add(Message(conversation_id=greeting.id, sender_type="user", msg_type="text", content="你好"))
    db.commit()

    seen = []

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        seen.append(query)
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "面签资料清单：身份证", "source": "注册资料"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["带上身份证"], intent="consult_feature", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    count = await services.replay_unanswered_phrase("面签资料清单")
    db.expire_all()
    db.refresh(conversation)
    assert count == 1
    assert seen == ["面签资料清单"]
    assert conversation.mode == "human"
    reply = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "身份证" in reply.content
    assert db.query(Message).filter(
        Message.conversation_id == answered.id, Message.sender_type == "ai",
    ).count() == 1
    assert db.query(Message).filter(
        Message.conversation_id == greeting.id, Message.sender_type == "ai",
    ).count() == 0


@pytest.mark.asyncio
async def test_numbered_list_reply_uses_source_items(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="面签资料清单"))
    db.commit()
    source = "\n".join([
        "【面签资料清单】：",
        "1、董事个人身份证和港澳通行证",
        "2、 香港公司全套注册资料原件",
        "3、公司业务证明和个人地址证明",
        "4、开户调查问卷",
    ])

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": source, "source": "注册.md"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["需要准备开户调查问卷"], intent="consult_feature", confidence=0.8)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    monkeypatch.setattr(engine.settings, "humanize_base_delay_ms", 0)
    monkeypatch.setattr(engine.settings, "humanize_per_char_ms", 0)

    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    db.refresh(conversation)
    assert conversation.mode == "ai"
    sent = "\n".join(
        row.content for row in db.query(Message).filter(
            Message.conversation_id == conversation.id, Message.sender_type == "ai",
        )
    )
    assert "董事个人身份证和港澳通行证" in sent
    assert "香港公司全套注册资料原件" in sent
    assert "公司业务证明和个人地址证明" in sent
    assert "开户调查问卷" in sent
    assert "需要准备开户调查问卷" not in sent
    assert "清单我按资料发你\n\n1、董事个人身份证和港澳通行证\n2、香港公司全套注册资料原件" in sent
    assert "2、 香港" not in sent
    assert db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).count() == 1


_MIANQIAN_ITEMS = [
    "1、香港开户请勿与开户经理提及被制裁国家，您的所有生意和转账地区仅限kyc内填写的地区国家。",
    "2、去银行开户仅需要面签人员进场，其他人员不要进入银行。",
    "3、去银行不要左顾右盼，不要戴耳机。对工作人员礼貌一些。",
    "4、对自己的生意模式、合作伙伴、公司基本信息需要了如指掌，不能一问三不知。",
    "5、在银行内部不要拍照、拍视频等。",
    "6、开户请勿提及付钱开户，一律回复自己预约的银行开户。",
    "7、如果经理推理财保险，不需要的话请委婉拒绝说要先了解一下",
    "8、董事手机提前开通好漫游，用来接受银行短信",
]


@pytest.mark.asyncio
async def test_single_question_list_is_one_verbatim_message(db, conversation, monkeypatch):
    """问法没有「清单」，第二段召回里的 8 条也要原文进同一条消息。"""
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="面签遵循哪些提示"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[
                {"content": "面签时注意不要提及敏感国家", "source": "面签说明"},
                {"content": "\n".join(_MIANQIAN_ITEMS), "source": "面签提示"},
            ],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(
            reply_messages=["不要提及敏感国家", "进场的只有面签人员，别的不要进哈"],
            intent="other", confidence=0.9,
        )

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    rows = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).all()
    assert len(rows) == 1
    sent = rows[0].content
    for item in (
        "被制裁国家", "kyc", "不要进入银行", "不要戴耳机", "不能一问三不知",
        "不要拍照", "付钱开户", "理财保险", "开通好漫游",
    ):
        assert item in sent
    assert "不要提及敏感国家" not in sent


@pytest.mark.asyncio
async def test_other_list_without_list_wording_stays_verbatim(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="退货要注意什么"))
    db.commit()
    source = "\n".join([
        "1、保持包装完整",
        "2、七天内寄回",
        "3、附上订单号",
    ])

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": source, "source": "退货"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["包装别拆就行"], intent="after_sale", confidence=0.8)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    rows = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).all()
    assert len(rows) == 1
    sent = rows[0].content
    assert "保持包装完整" in sent
    assert "七天内寄回" in sent
    assert "附上订单号" in sent
    assert "包装别拆就行" not in sent


@pytest.mark.asyncio
async def test_named_one_list_item_does_not_dump_the_rest(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="开户调查问卷"))
    db.commit()
    source = "\n".join([
        "1、董事个人身份证和港澳通行证",
        "2、香港公司全套注册资料原件",
        "3、开户调查问卷",
    ])

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": source, "source": "开户"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["问卷填一下就行"], intent="consult_feature", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    sent = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one().content
    assert "开户调查问卷" in sent
    assert "董事个人身份证" not in sent
    assert "香港公司全套注册资料" not in sent


@pytest.mark.asyncio
async def test_price_without_numbered_list_stays_price(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="这款多少钱"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "这款 99 元", "source": "价格"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["这款 99 元"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    sent = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one().content
    assert "99" in sent
    assert "清单我按资料发你" not in sent


@pytest.mark.asyncio
async def test_two_questions_stay_separate_messages(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text",
        content="多少钱，还包邮吗",
    ))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "多少钱是 99 元，包邮是全国包邮", "source": "价格"}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["这款 99 元", "全国包邮"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    rows = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).all()
    assert len(rows) == 2
    sent = "\n".join(row.content for row in rows)
    assert "99" in sent
    assert "包邮" in sent


@pytest.mark.asyncio
async def test_miss_answers_from_earlier_dialogue(db, conversation, monkeypatch):
    from app.schemas import AgentReply

    db.add(Message(
        conversation_id=conversation.id, sender_type="agent", msg_type="text",
        content="明天可以去香港开户",
    ))
    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text",
        content="我说的是哪天去香港开户",
    ))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return rag_pipeline.RetrievalResult(
            passed=False, reason="rerank_below_threshold", rewritten_queries=[query],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["你说的是明天"], intent="other", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    db.refresh(conversation)
    assert conversation.mode == "ai"
    reply = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "明天" in reply.content
    assert db.query(Message).filter(
        Message.conversation_id == conversation.id,
        Message.content == "这条没对上资料，需要人工回复",
    ).count() == 0
    assert db.query(MissedQuestion).filter(
        MissedQuestion.conversation_id == conversation.id,
    ).count() == 0


@pytest.mark.asyncio
async def test_rate_limit_keeps_body_when_already_human(db, conversation, monkeypatch):
    from app.core import ratelimit
    from app.services import send_outbound

    conversation.platform = "douyin"
    conversation.mode = "human"
    db.commit()
    ratelimit.reset_all()
    key = conversation.platform_conversation_id
    for _ in range(6):
        assert ratelimit.check_and_count("douyin", key)[0] is True

    sent = await send_outbound(conversation.id, "面签要带身份证", sender_type="ai", allow_owned=True)
    db.expire_all()
    assert sent is None
    body = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "身份证" in body.content
    note = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "system",
    ).one()
    assert "频控" in note.content
    assert conversation.mode == "human"
    ratelimit.reset_all()


def _msg(conversation, sender_type, content, *, minutes_ago=0, internal=False, extra=None):
    return Message(
        conversation_id=conversation.id,
        sender_type=sender_type,
        msg_type="text",
        content=content,
        is_internal=internal,
        extra=extra or {},
        created_at=datetime.utcnow() - timedelta(minutes=minutes_ago),
    )


def test_wait_badge_clears_after_ai_or_agent_reply(db, conversation):
    """最后一条用户消息后面有非内部 AI 或人工回复时，不再显示等待分钟数。"""
    from app.api.conversations import _to_out

    conversation.mode = "human"
    db.add(_msg(conversation, "user", "在吗", minutes_ago=5))
    db.commit()
    waiting = _to_out(db, conversation)
    assert waiting.awaiting_first_response is True
    assert waiting.wait_seconds >= 60

    db.add(_msg(conversation, "ai", "在的"))
    db.commit()
    assert _to_out(db, conversation).awaiting_first_response is False

    db.add(_msg(conversation, "user", "再问一下", minutes_ago=1))
    db.commit()
    again = _to_out(db, conversation)
    assert again.awaiting_first_response is True

    db.add(_msg(conversation, "agent", "我来回复"))
    db.commit()
    assert _to_out(db, conversation).awaiting_first_response is False


def test_internal_note_does_not_clear_wait_badge(db, conversation):
    from app.api.conversations import _to_out

    conversation.mode = "pending"
    db.add(_msg(conversation, "user", "需要人工", minutes_ago=2))
    db.add(_msg(conversation, "agent", "同事先看一下", internal=True))
    db.commit()
    out = _to_out(db, conversation)
    assert out.awaiting_first_response is True
    assert out.wait_seconds > 0


def test_ai_reply_keeps_transferred_in_flag(db, conversation):
    """AI 补答清掉等待计时，但不算人工接手，转入标记还在。"""
    from app.api.conversations import _to_out

    agent = _agent(db, name="接手")
    conversation.mode = "human"
    conversation.assignee_id = agent.id
    db.add(_msg(conversation, "user", "转过来了", minutes_ago=3))
    db.add(_msg(
        conversation, "system", "会话已转接",
        extra={"event": "transfer", "to_agent_id": agent.id},
    ))
    db.add(_msg(conversation, "ai", "我先答一下"))
    db.commit()

    out = _to_out(db, conversation, viewer_id=agent.id)
    assert out.awaiting_first_response is False
    assert out.transferred_in is True
