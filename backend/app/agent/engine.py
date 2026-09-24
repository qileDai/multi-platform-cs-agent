"""Agent 引擎：提示词渲染 → LLM 调用 → 契约校验 → 工具调用（两阶段）→ 动作执行。

动作：分条发送回复 / 打标签 / 留资提取 / 转人工 / 业务工具调用（查订单/查物流/建工单）。
工具调用循环：LLM 输出 tool_call → 执行工具 → 结果回填提示词 → 二次生成，最多 2 次防死循环。
LLM 未配置时降级：固定话术 + 直接转人工，保证全流程可跑通。
主模型硬失败（网络/服务异常）时自动切换备用模型（LLM_FALLBACK_*）。
"""
import asyncio
import json
import logging
import re
from datetime import datetime

from openai import AsyncOpenAI
from pydantic import ValidationError

from ..config import settings
from ..core import monitor
from ..database import SessionLocal
from ..models import Conversation, Customer, KnowledgeDoc, LlmUsage, Message
from ..rag import pipeline
from ..schemas import AgentReply
from ..services import handoff, note_unmatched, record_missed_question, send_outbound
from . import context, humanize, prompt as prompt_mod, tools

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 2  # 工具调用上限（防死循环）
_GROUNDED_AMOUNT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:元|块|%|天|小时)")
_GROUNDING_REPLY = "这个数我这边对不上，先帮您转给同事哈"
_GREETING_REPLY = "在的呢，想问啥呀"
_LIST_ITEM_RE = re.compile(r"^\s*(?:\d+\s*[.、．)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*\S")
_LIST_MARKER_RE = re.compile(r"^(?:\d+\s*[.、．)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*")
_LIST_LEAD = "清单我按资料发你"
_EMPTY_REPLY = "不好意思，我这边没说清楚，先帮您转给同事哈"
_MISS_REPLY = "这个问题我这边没查到靠谱资料，先帮您转给同事哈"
_GREETINGS = frozenset({
    "你好", "您好", "在吗", "在么", "嗨", "哈喽", "早上好", "谢谢", "哈哈",
    "hi", "hello",
})
_GREETING_TAILS = "呀啊呢哈哦"


def is_pure_greeting(text: str) -> bool:
    """整句只是招呼。后面还带着具体问题时返回 False，继续检索。"""
    cleaned = re.sub(r"[\s，。！？、~～!?,.·…]+", "", text or "")
    if cleaned in _GREETINGS:
        return True
    if cleaned and cleaned[-1] in _GREETING_TAILS and cleaned[:-1] in _GREETINGS:
        return True
    return False


async def process_ai_reply(conversation_id: int, *, local: bool = False,
                           allow_owned: bool = False) -> str:
    """对一条用户消息执行完整 AI 接待流程。

    local=True 时只在本系统入库并返回拼成一段的正文，不走平台发送，也不做打字延迟。
    供知你快回同步回复接口使用。默认路径的返回值可忽略。
    """
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        owned = allow_owned and conversation is not None and conversation.mode in ("pending", "human")
        if conversation is None or conversation.status != "open":
            return ""
        if conversation.mode != "ai" and not owned:
            return ""
        customer = db.get(Customer, conversation.customer_id)
        last_user_msg = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id, Message.sender_type == "user")
            .order_by(Message.id.desc())
            .first()
        )
        if last_user_msg is None:
            return ""
        user_text = last_user_msg.content
        platform = conversation.platform
        conversation_id_ = conversation.id
        customer_id = customer.id
        user_message_id = last_user_msg.id
    finally:
        db.close()

    if is_pure_greeting(user_text):
        return await _deliver_ai(
            conversation_id_, [_GREETING_REPLY], local=local, allow_owned=owned,
            extra={"intent": "chitchat", "confidence": 1.0, "citations": []},
        )

    # LLM 未配置：AI 接待降级转人工。已经是排队或人工时不再发降级句，留给客服。
    if not settings.llm_configured:
        if owned:
            return ""
        text = await _deliver_ai(
            conversation_id_, ["这会儿咨询有点多，我先帮您叫同事过来哈"], local=local)
        await handoff(conversation_id_, reason="llm_not_configured")
        return text

    # 1. 上下文窗口
    history_text, recent, summary = context.get_history_for_prompt(conversation_id_)

    # 2. RAG 检索。未过阈值：固定安抚话术 + 硬转人工，不把「无匹配资料」交给 LLM 编答案。
    retrieval = await pipeline.retrieve(user_text, history=recent, summary=summary)
    _save_retrieval_trace(user_message_id, retrieval)
    if not retrieval.passed:
        remembered = await _reply_from_dialogue(
            conversation_id_, user_text, recent, local=local, allow_owned=owned)
        if remembered is not None:
            return remembered
        record_missed_question(user_text, platform, conversation_id_)
        if owned:
            await note_unmatched(conversation_id_)
            return ""
        text = await _deliver_ai(
            conversation_id_,
            [_MISS_REPLY],
            local=local,
            extra={"intent": "other", "confidence": 0.0, "citations": []},
        )
        await handoff(conversation_id_, reason="low_confidence")
        return text
    knowledge_context = _format_knowledge_context(retrieval.contexts)

    # 3. 渲染提示词 + 调用 LLM（失败重试 1 次，主模型硬失败自动切备用）
    rewritten = retrieval.rewritten_queries[0] if retrieval.rewritten_queries else user_text
    rendered = prompt_mod.render_prompt(
        platform=platform,
        knowledge_context=knowledge_context,
        history_text=history_text,
        user_message=user_text,
        customer_profile=context.customer_profile_text(conversation_id_),
        rewritten_question=rewritten,
    )
    reply = await _call_llm_with_retry(rendered, conversation_id=conversation_id_)

    # 3.5 工具调用循环：LLM 请求办事 → 执行工具 → 结果回填 → 二次生成（最多 MAX_TOOL_ROUNDS 次）
    tool_ctx = tools.ToolContext(
        conversation_id=conversation_id_, customer_id=customer_id, platform=platform)
    tool_names_used: list[str] = []
    tool_rounds = 0
    while reply is not None and reply.tool_call and tool_rounds < MAX_TOOL_ROUNDS:
        tool_rounds += 1
        call = reply.tool_call
        tool_names_used.append(call.name)
        result = await tools.execute_tool(call.name, call.args, tool_ctx)
        rendered = rendered + tools.tool_result_text(
            call.name, result, allow_chain=tool_rounds < MAX_TOOL_ROUNDS)
        reply = await _call_llm_with_retry(rendered, conversation_id=conversation_id_)

    if reply is None or _tool_rounds_exhausted(reply, tool_rounds):
        # 多次重试仍失败，或工具轮次用尽却没有可发的回复：安全兜底
        text = await _deliver_ai(
            conversation_id_, ["不好意思，我这边卡了一下"], local=local, allow_owned=owned)
        reason = "llm_parse_failed" if reply is None else "tool_rounds_exhausted"
        await handoff(conversation_id_, reason=reason)
        return text

    if (
        not tool_names_used
        and reply.reply_messages
        and _has_ungrounded_amount(reply.reply_messages, retrieval.contexts)
    ):
        text = await _deliver_ai(
            conversation_id_, [_GROUNDING_REPLY], local=local, allow_owned=owned,
            extra={"intent": reply.intent, "confidence": 0.0, "citations": [], "grounding": "blocked"},
        )
        await handoff(conversation_id_, reason="low_confidence")
        return text

    listed = _reply_with_source_list(reply.reply_messages, retrieval.contexts)
    if listed is not None:
        text = await _deliver_ai(
            conversation_id_, listed, local=local, allow_owned=owned,
            extra={"intent": reply.intent, "confidence": reply.confidence, "citations": [c["source"] for c in retrieval.contexts]},
        )
        _bump_knowledge_hits(retrieval.contexts)
        return text

    if not reply.handoff and not reply.reply_messages:
        text = await _deliver_ai(
            conversation_id_, [_EMPTY_REPLY], local=local, allow_owned=owned,
            extra={"intent": reply.intent, "confidence": 0.0, "citations": []},
        )
        await handoff(conversation_id_, reason="low_confidence")
        return text

    # 4. 执行动作：标签 / 留资
    _apply_side_effects(customer_id, reply)

    # 5. 转人工优先
    citations = [c["source"] for c in retrieval.contexts]
    extra = {"intent": reply.intent, "confidence": reply.confidence, "citations": citations}
    if tool_names_used:
        extra["tool_calls"] = tool_names_used
    if reply.handoff:
        text = ""
        if reply.reply_messages:
            text = await _deliver_ai(
                conversation_id_, reply.reply_messages, local=local, allow_owned=owned, extra=extra)
            _bump_knowledge_hits(retrieval.contexts)
        await handoff(conversation_id_, reason=reply.handoff_reason or "unknown")
        return text

    # 6. 正常回复（拟人化分条发送；知你快回通道拼成一段本地入库）
    text = ""
    if reply.reply_messages:
        text = await _deliver_ai(
            conversation_id_, reply.reply_messages, local=local, allow_owned=owned, extra=extra)
        _bump_knowledge_hits(retrieval.contexts)

    # 7. 滚动小结。知你快回同步回复不等待小结，避免占用接口时限。
    if local:
        asyncio.create_task(context.maybe_update_summary(conversation_id_))
    else:
        await context.maybe_update_summary(conversation_id_)
    return text


def _earlier_dialogue(user_text: str, recent: list[dict]) -> list[dict]:
    """去掉当前这句，只留更早的用户、客服原文。"""
    rows = list(recent or [])
    if rows and rows[-1].get("sender_type") == "user" and rows[-1].get("content") == user_text:
        rows = rows[:-1]
    return [
        row for row in rows
        if row.get("sender_type") in ("user", "ai", "agent") and (row.get("content") or "").strip()
    ]


async def _reply_from_dialogue(conversation_id: int, user_text: str, recent: list[dict], *,
                               local: bool, allow_owned: bool) -> str | None:
    """知识库没有时，只根据刚才的对话回答。对话里没有这个事实就返回 None。"""
    earlier = _earlier_dialogue(user_text, recent)
    if not earlier:
        return None
    lines = []
    for row in earlier:
        role = {"user": "用户", "ai": "客服", "agent": "人工客服"}.get(row["sender_type"], "客服")
        lines.append(f"{role}: {row['content']}")
    rendered = (
        "下面是已经发生的对话。用户现在又问了一句。"
        "只有对话里已经说过的事实才能回答，不要查知识库，不要编造。"
        "能回答时输出 JSON：{\"reply_messages\":[\"一句短回复\"],\"intent\":\"other\",\"confidence\":0.9,\"handoff\":false}。"
        "对话里没有这个事实时输出 JSON：{\"reply_messages\":[],\"intent\":\"other\",\"confidence\":0,\"handoff\":false}。\n\n"
        f"已有对话：\n" + "\n".join(lines) + f"\n\n用户现在问：{user_text}"
    )
    reply = await _call_llm_with_retry(rendered, conversation_id=conversation_id)
    if reply is None or reply.handoff or not reply.reply_messages:
        return None
    return await _deliver_ai(
        conversation_id, reply.reply_messages[:1], local=local, allow_owned=allow_owned,
        extra={"intent": "other", "confidence": reply.confidence, "citations": [], "from_dialogue": True},
    )


def _numbered_items(text: str) -> list[str]:
    return [line.strip() for line in (text or "").splitlines() if _LIST_ITEM_RE.match(line.strip())]


def _format_list_item(item: str) -> str:
    """编号和正文之间不留空格，正文保持原样。"""
    match = _LIST_MARKER_RE.match(item.strip())
    if match is None:
        return item.strip()
    marker = re.sub(r"\s+", "", match.group(0))
    body = item.strip()[match.end():].strip()
    return f"{marker}{body}"


def _format_source_list(items: list[str]) -> str:
    lines = [_format_list_item(item) for item in items]
    return f"{_LIST_LEAD}\n\n" + "\n".join(lines)


def _reply_with_source_list(messages: list[str], contexts: list[dict]) -> list[str] | None:
    """最相关资料是编号清单，而回复没逐条带上时，改发原文条目。"""
    if not contexts:
        return None
    items = _numbered_items(contexts[0].get("content") or "")
    if len(items) < 2:
        return None
    blob = "\n".join(messages or [])
    for item in items:
        anchor = _LIST_MARKER_RE.sub("", item).strip()
        if len(anchor) > 12:
            anchor = anchor[:12]
        if anchor and anchor not in blob:
            return [_format_source_list(items)]
    return None


def _has_ungrounded_amount(messages: list[str], contexts: list[dict]) -> bool:
    """回复里的价格、百分比、天数必须能在召回正文里找到同一个数字。"""
    blob = "\n".join((item.get("content") or "") for item in contexts)
    for message in messages:
        for match in _GROUNDED_AMOUNT.finditer(message):
            number = match.group(1)
            if re.search(rf"(?<!\d){re.escape(number)}(?!\d)", blob) is None:
                return True
    return False


def _save_retrieval_trace(message_id: int, retrieval: pipeline.RetrievalResult) -> None:
    """把这一轮检索写到用户消息上。未通过时也写，方便看出为什么转人工。"""
    db = SessionLocal()
    try:
        msg = db.get(Message, message_id)
        if msg is None:
            return
        extra = dict(msg.extra or {})
        extra["retrieval"] = {
            "queries": list(retrieval.rewritten_queries),
            "dense_count": retrieval.dense_count,
            "bm25_count": retrieval.bm25_count,
            "fused_top": list(retrieval.fused_top),
            "rerank_top_score": retrieval.rerank_top_score,
            "reason": retrieval.reason,
            "rerank_status": retrieval.rerank_status,
        }
        msg.extra = extra
        db.commit()
    finally:
        db.close()


def _format_knowledge_context(contexts: list[dict]) -> str:
    """第一条标成最相关，其余只作补充，避免模型把不同资料的数字拼在一起。"""
    blocks = []
    for i, item in enumerate(contexts):
        role = "最相关" if i == 0 else "仅补充，数字冲突时忽略"
        blocks.append(f"【资料{i + 1}｜{role}】（来源：{item['source']}）\n{item['content']}")
    return "\n\n".join(blocks)


def _bump_knowledge_hits(contexts: list[dict]) -> None:
    """一次接待只给每篇被引用的知识加 1，不按气泡条数重复计。"""
    doc_ids: list[int] = []
    seen: set[int] = set()
    for item in contexts:
        doc_id = item.get("doc_id")
        if not isinstance(doc_id, int) or doc_id in seen:
            continue
        seen.add(doc_id)
        doc_ids.append(doc_id)
    if not doc_ids:
        return
    db = SessionLocal()
    try:
        docs = db.query(KnowledgeDoc).filter(KnowledgeDoc.id.in_(doc_ids)).all()
        for doc in docs:
            doc.hit_count = (doc.hit_count or 0) + 1
        db.commit()
    finally:
        db.close()


async def _deliver_ai(conversation_id: int, messages: list[str], *, local: bool,
                      extra: dict | None = None, allow_owned: bool = False) -> str:
    """发出 AI 正文。local 时拼成一条本地消息并返回实际入库文本。"""
    parts = [m.strip() for m in messages if isinstance(m, str) and m.strip()]
    if not parts:
        return ""
    if local:
        from ..services import record_local_ai_message
        saved = await record_local_ai_message(
            conversation_id, "\n".join(parts)[:4000], extra, allow_owned=allow_owned)
        return saved.content if saved is not None else ""
    if len(parts) == 1:
        await send_outbound(
            conversation_id, parts[0], sender_type="ai", extra=extra, allow_owned=allow_owned)
        return parts[0] if allow_owned else ""
    await _send_replies(conversation_id, parts, extra or {}, allow_owned=allow_owned)
    return "\n".join(parts) if allow_owned else ""


async def _send_replies(conversation_id: int, messages: list[str], extra: dict,
                        allow_owned: bool = False):
    async def _send(content: str) -> bool:
        sent = await send_outbound(
            conversation_id, content, sender_type="ai", extra=extra, allow_owned=allow_owned)
        return sent is not None
    await humanize.send_humanized(messages, _send)


def _tool_rounds_exhausted(reply: AgentReply, tool_rounds: int) -> bool:
    """工具打满上限后仍在要工具、且一条回复都没有。已声明转人工的交给后面的 handoff。"""
    return (
        tool_rounds >= MAX_TOOL_ROUNDS
        and reply.tool_call is not None
        and not reply.reply_messages
        and not reply.handoff
    )


async def _call_llm_with_retry(rendered_prompt: str, *, conversation_id: int = 0) -> AgentReply | None:
    """主模型调用（解析失败重试 1 次）；硬失败（网络/服务异常）时自动切换备用模型再试一轮。"""
    reply, hard_failed = await _call_llm_once(
        rendered_prompt, conversation_id=conversation_id,
        base_url=settings.llm_base_url, api_key=settings.llm_api_key, model=settings.llm_model,
    )
    if hard_failed and settings.llm_fallback_configured:
        logger.warning("主 LLM 不可用，切换备用模型 %s", settings.llm_fallback_model)
        monitor.record("llm_failure", f"主模型 {settings.llm_model} 失败，切换备用模型")
        reply, _ = await _call_llm_once(
            rendered_prompt, conversation_id=conversation_id,
            base_url=settings.llm_fallback_base_url or settings.llm_base_url,
            api_key=settings.llm_fallback_api_key, model=settings.llm_fallback_model,
        )
    return reply


def _record_usage(conversation_id: int, model: str, usage) -> None:
    """记录 token 用量（独立短会话写入；失败静默，绝不影响回复主流程）。"""
    if usage is None:
        return
    try:
        db = SessionLocal()
        try:
            db.add(LlmUsage(
                conversation_id=conversation_id, model=model,
                prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
                completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
                total_tokens=getattr(usage, "total_tokens", 0) or 0,
            ))
            db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.warning("token 用量记录失败", exc_info=True)


async def _call_llm_once(rendered_prompt: str, *, base_url: str, api_key: str,
                         model: str, conversation_id: int = 0) -> tuple[AgentReply | None, bool]:
    """调用指定模型并用 pydantic 校验契约；解析失败带错误反馈重试 1 次。

    返回 (reply, hard_failed)：hard_failed=True 表示网络/服务级异常（调用方可用备用模型兜底）。
    """
    client = AsyncOpenAI(base_url=base_url, api_key=api_key)
    messages = [{"role": "user", "content": rendered_prompt}]
    raw = ""

    for attempt in range(2):
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.3,
                response_format={"type": "json_object"},
            )
            _record_usage(conversation_id, model, getattr(resp, "usage", None))
            raw = resp.choices[0].message.content or ""
            return _parse_contract(raw), False
        except (ValidationError, json.JSONDecodeError) as exc:
            logger.warning("契约解析失败（第 %d 次）: %s", attempt + 1, exc)
            if attempt == 0:
                # 把错误反馈给模型重试
                messages.append({"role": "assistant", "content": raw})
                messages.append({"role": "user", "content":
                    f"你的输出不符合契约，错误：{exc}。请只输出正确的 JSON 对象，不要输出其他内容。"})
            continue
        except Exception:  # noqa: BLE001
            logger.exception("LLM 调用失败 model=%s", model)
            monitor.record("llm_failure", f"model={model}")
            return None, True
    return None, False


def _parse_contract(raw: str) -> AgentReply:
    """容错解析：剥掉 markdown 代码块，提取第一个 JSON 对象；reply_messages 预清洗。"""
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise json.JSONDecodeError("未找到 JSON 对象", text, 0)
    data = json.loads(text[start:end + 1])
    # 预清洗：过滤空消息、截断到 3 条（在校验前，避免模型给 4 条时整体校验失败）
    if isinstance(data.get("reply_messages"), list):
        data["reply_messages"] = [
            m.strip() for m in data["reply_messages"] if isinstance(m, str) and m.strip()
        ][:3]
    return AgentReply.model_validate(data)


def _apply_side_effects(customer_id: int, reply: AgentReply):
    """标签合并 + 留资更新。"""
    db = SessionLocal()
    try:
        customer = db.get(Customer, customer_id)
        if customer is None:
            return
        if reply.tags:
            existing = list(customer.tags or [])
            for tag in reply.tags:
                if tag and tag not in existing:
                    existing.append(tag)
            customer.tags = existing
        if reply.lead.phone:
            customer.lead_phone = reply.lead.phone
        if reply.lead.wechat:
            customer.lead_wechat = reply.lead.wechat
        if reply.lead.note:
            customer.lead_note = reply.lead.note
        customer.updated_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()
