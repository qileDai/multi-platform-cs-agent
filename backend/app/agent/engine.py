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
import time
from datetime import datetime

from openai import AsyncOpenAI
from pydantic import ValidationError

from ..config import settings
from ..core import monitor
from ..database import SessionLocal
from ..models import Conversation, Customer, KnowledgeDoc, LlmUsage, Message
from ..rag import cache as answer_cache, pipeline
from ..schemas import AgentReply
from ..services import handoff, note_unmatched, record_missed_question, send_outbound
from . import context, evidence, humanize, prompt as prompt_mod, tools

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 2  # 工具调用上限（防死循环）
REPLY_BUDGET_SECONDS = 12
_CONFIRM_REPLY = "我先让同事帮您确认"
_TASK_RE = re.compile(r"订单|物流|快递|退货|退换|换货|退款")
_FACT_TOOLS = frozenset({"query_order", "query_logistics"})
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

    started = time.monotonic()
    history_text, recent, summary = context.get_history_for_prompt(conversation_id_)
    cached = await answer_cache.lookup(user_text)
    if _over_budget(started):
        return await _confirm_and_handoff(conversation_id_, user_text, platform, local=local, allow_owned=owned, owned=owned)

    retrieval = await _retrieve_covering(user_text, recent, summary)
    _save_retrieval_trace(user_message_id, retrieval)
    agent_lines = _agent_fact_lines(recent)
    if cached and _cache_still_grounded(cached, retrieval, agent_lines):
        return await _deliver_ai(
            conversation_id_, cached, local=local, allow_owned=owned,
            extra={"intent": "other", "confidence": 1.0, "citations": [], "cache_hit": True, "grounded": True},
        )
    if cached:
        answer_cache.invalidate_messages(cached)

    tool_results: list[dict] = []
    tool_names_used: list[str] = []
    if retrieval.passed:
        reply = await _answer_from_knowledge(
            conversation_id_, customer_id, platform, user_text, history_text, retrieval, started,
            tool_results, tool_names_used,
        )
    else:
        reply = await _answer_without_knowledge(
            conversation_id_, customer_id, platform, user_text, recent, started,
            tool_results, tool_names_used, local=local, allow_owned=owned, owned=owned,
        )
        if isinstance(reply, str):
            return reply
        if reply is None:
            reply = AgentReply()

    if retrieval.passed and (reply is None or _tool_rounds_exhausted(reply, len(tool_names_used))):
        text = await _deliver_ai(
            conversation_id_, ["不好意思，我这边卡了一下"], local=local, allow_owned=owned)
        reason = "llm_parse_failed" if reply is None else "tool_rounds_exhausted"
        await handoff(conversation_id_, reason=reason)
        return text

    if reply is None:
        reply = AgentReply()

    if _over_budget(started) and not reply.reply_messages:
        return await _confirm_and_handoff(conversation_id_, user_text, platform, local=local, allow_owned=owned, owned=owned)

    listed = _reply_with_source_list(user_text, retrieval.contexts, retrieval.facets)
    messages = listed if listed is not None else list(reply.reply_messages)
    blob = evidence.evidence_text(retrieval.contexts, tool_results, agent_lines)
    kept, dropped = evidence.partition_messages(messages, blob, retrieval.contexts)
    gaps = list(retrieval.gaps)
    forced_human = reply.handoff_reason in ("complaint", "explicit_human", "sensitive", "out_of_scope")
    tool_ok = _tool_answered(tool_names_used, tool_results)
    need_fallback = (not forced_human) and (bool(gaps) or not kept) and not tool_ok
    used_fallback = False
    if need_fallback and not _over_budget(started):
        fallback = await _llm_fallback(
            conversation_id_, user_text, kept, gaps, recent, started,
        )
        used_fallback = True
        if fallback is not None:
            fb_kept, fb_dropped = evidence.partition_messages(fallback.reply_messages, blob, retrieval.contexts)
            dropped.extend(fb_dropped)
            for line in fb_kept:
                if line not in kept:
                    kept.append(line)
            if fallback.handoff:
                reply.handoff = True
                reply.handoff_reason = fallback.handoff_reason or reply.handoff_reason or "low_confidence"
            if not reply.intent or reply.intent == "other":
                reply.intent = fallback.intent
    elif need_fallback:
        if not any(evidence.is_handoff_guide(line) for line in kept):
            kept.append(_CONFIRM_REPLY)
        reply.handoff = True
        reply.handoff_reason = reply.handoff_reason or "low_confidence"

    shop_gap = bool(gaps) or ((not retrieval.passed) and _expects_shop_fact(user_text) and not tool_ok)
    if not kept:
        kept = [_CONFIRM_REPLY]
        reply.handoff = True
        reply.handoff_reason = reply.handoff_reason or "low_confidence"
    if shop_gap or (reply.handoff and forced_human):
        reply.handoff = True
        reply.handoff_reason = reply.handoff_reason or "low_confidence"
    if used_fallback and not shop_gap and not forced_human and kept and not reply.handoff:
        reply.handoff = False

    messages = kept[:3]
    if len(retrieval.facets) < 2 and len(messages) > 1:
        messages = ["\n".join(messages)]
    _apply_side_effects(customer_id, reply)
    citations = [c["source"] for c in retrieval.contexts]
    must_handoff = bool(reply.handoff) or shop_gap
    extra = {
        "intent": reply.intent,
        "confidence": reply.confidence,
        "citations": citations,
        "grounded": not must_handoff,
        "facets": list(retrieval.facets),
        "gaps": gaps,
        "dropped": dropped,
        "fallback": used_fallback,
    }
    if tool_names_used:
        extra["tool_calls"] = tool_names_used
    if messages:
        text = await _deliver_ai(conversation_id_, messages, local=local, allow_owned=owned, extra=extra)
        if retrieval.passed and not must_handoff:
            _bump_knowledge_hits(retrieval.contexts)
            if not _FACT_TOOLS.intersection(tool_names_used):
                doc_ids = [item["doc_id"] for item in retrieval.contexts if isinstance(item.get("doc_id"), int)]
                await answer_cache.store(user_text, messages, doc_ids)
    else:
        text = ""
    if must_handoff:
        if shop_gap or not retrieval.passed:
            record_missed_question(gaps[0] if gaps else user_text, platform, conversation_id_)
        await handoff(conversation_id_, reason=reply.handoff_reason or "low_confidence")
        return text
    if local:
        asyncio.create_task(context.maybe_update_summary(conversation_id_))
    else:
        await context.maybe_update_summary(conversation_id_)
    return text


_SHOP_FACT = re.compile(
    r"多少钱|什么价|价格|几元|几块|包邮|运费|邮费|发货|退货|退换|换货|退款|发票|质保|保修|"
    r"库存|有货|营业|几点|地址|尺码|颜色|优惠|折扣|几天|多久|周末"
)


def _over_budget(started: float) -> bool:
    return time.monotonic() - started > REPLY_BUDGET_SECONDS


def _expects_shop_fact(user_text: str) -> bool:
    return bool(_SHOP_FACT.search(user_text or ""))


def _context_key(item: dict) -> tuple:
    return (item.get("chunk_id"), item.get("doc_id"), item.get("content"))


async def _retrieve_covering(user_text: str, recent: list[dict], summary: str) -> pipeline.RetrievalResult:
    """单问只检索一次。多问先整句，没盖住的子问题再各检一次，合并最多 3 条。"""
    primary = await pipeline.retrieve(user_text, history=recent, summary=summary)
    facets = pipeline.split_facets(user_text)
    primary.facets = facets
    if len(facets) < 2:
        return primary
    merged = list(primary.contexts)
    seen = {_context_key(item) for item in merged}
    gaps: list[str] = []
    for facet in facets:
        if pipeline.facet_covered(facet, merged):
            continue
        extra = await pipeline.retrieve(facet, history=recent, summary=summary)
        for item in extra.contexts:
            key = _context_key(item)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
        if not pipeline.facet_covered(facet, merged):
            gaps.append(facet)
    primary.contexts = merged[:3]
    primary.gaps = gaps
    if primary.contexts and not primary.passed:
        primary.passed = True
        primary.reason = "passed"
    return primary


def _cache_still_grounded(messages: list[str], retrieval: pipeline.RetrievalResult,
                          agent_lines: list[str]) -> bool:
    if not retrieval.passed or retrieval.gaps:
        return False
    blob = evidence.evidence_text(retrieval.contexts, [], agent_lines)
    kept, dropped = evidence.partition_messages(messages, blob, retrieval.contexts)
    return bool(kept) and not dropped


async def _llm_fallback(conversation_id: int, user_text: str, kept: list[str], gaps: list[str],
                        recent: list[dict], started: float) -> AgentReply | None:
    """知识或主回复接不住时再叫一次模型。只许复述已核对事实，或把缺口说成转人工。"""
    if _over_budget(started):
        return None
    facts = "\n".join(kept) or "（没有已核对事实）"
    missing = "、".join(gaps) or "知识库没有直接答案"
    lines = []
    for row in _earlier_dialogue(user_text, recent):
        role = "用户" if row.get("sender_type") == "user" else "客服"
        lines.append(f"{role}: {row.get('content') or ''}")
    prompt = (
        "你是客服阿茶，用 1 到 2 句微信口语回复。"
        "不要说「根据资料」「知识库显示」「您好，很高兴为您服务」。\n"
        "只能复述下面已经核对过的事实。"
        "不要用自己的记忆补充价格、折扣、期限、库存、是否包邮、能否退换、快递公司或单号。\n"
        "缺的是店铺事实时，用口语说要请同事确认，handoff 填 true，handoff_reason 填 low_confidence。\n"
        "只是闲聊，或要追问哪一款、手机号时，直接接话，handoff 填 false。\n"
        "投诉、辱骂、用户明确要真人时，先安抚再转人工，handoff 填 true。\n"
        f"已核对事实：\n{facts}\n还缺：{missing}\n"
        "已核对对话：\n" + ("\n".join(lines) or "（无）") + f"\n用户说：{user_text}\n"
        "只输出 JSON："
        '{"reply_messages":["一句"],"intent":"other","confidence":0.4,'
        '"handoff":false,"handoff_reason":"","tags":[],'
        '"lead":{"phone":"","wechat":"","note":""},"quick_action":"none","tool_call":null}'
    )
    return await _call_llm_with_retry(prompt, conversation_id=conversation_id)


def _tool_answered(names: list[str], results: list[dict]) -> bool:
    return any(name in _FACT_TOOLS and result.get("ok") for name, result in zip(names, results))


def _agent_fact_lines(recent: list[dict]) -> list[str]:
    lines = []
    for row in recent or []:
        content = (row.get("content") or "").strip()
        if not content:
            continue
        if row.get("sender_type") == "agent" or (row.get("sender_type") == "ai" and row.get("grounded")):
            lines.append(content)
    return lines


async def _confirm_and_handoff(conversation_id: int, user_text: str, platform: str, *,
                               local: bool, allow_owned: bool, owned: bool, record: bool = True) -> str:
    if record:
        record_missed_question(user_text, platform, conversation_id)
    if owned:
        await note_unmatched(conversation_id)
        return ""
    text = await _deliver_ai(
        conversation_id, [_CONFIRM_REPLY], local=local, allow_owned=allow_owned,
        extra={"intent": "other", "confidence": 0.0, "citations": [], "grounded": False},
    )
    await handoff(conversation_id, reason="low_confidence")
    return text


async def _answer_from_knowledge(conversation_id: int, customer_id: int, platform: str, user_text: str,
                                 history_text: str, retrieval, started: float,
                                 tool_results: list[dict], tool_names: list[str]) -> AgentReply | None:
    if _over_budget(started):
        return None
    rewritten = retrieval.rewritten_queries[0] if retrieval.rewritten_queries else user_text
    rendered = prompt_mod.render_prompt(
        platform=platform,
        knowledge_context=_format_knowledge_context(retrieval.contexts, retrieval.gaps),
        history_text=history_text,
        user_message=user_text,
        customer_profile=context.customer_profile_text(conversation_id),
        rewritten_question=rewritten,
    )
    reply = await _call_llm_with_retry(rendered, conversation_id=conversation_id)
    return await _consume_tools(
        conversation_id, customer_id, platform, rendered, reply, tool_results, tool_names,
    )


async def _answer_without_knowledge(conversation_id: int, customer_id: int, platform: str, user_text: str,
                                    recent: list[dict], started: float, tool_results: list[dict],
                                    tool_names: list[str], *, local: bool, allow_owned: bool, owned: bool):
    """没检索到时：办事先调工具，否则只用人工原话，再不行就兜底并转人工。"""
    if _over_budget(started):
        return await _confirm_and_handoff(
            conversation_id, user_text, platform, local=local, allow_owned=allow_owned, owned=owned)
    if _TASK_RE.search(user_text or ""):
        if _over_budget(started):
            return await _confirm_and_handoff(
                conversation_id, user_text, platform, local=local, allow_owned=allow_owned, owned=owned)
        rendered = (
            "你是客服阿茶。用户在查订单、物流或退换。可以调用工具。"
            "没有真实结果就不要编造单号、快递和价格。"
            "查到之后用 1 到 2 句微信口语说结果，不要说「根据查询结果」。"
            "只输出 JSON 契约。\n\n"
            + tools.tools_prompt_text()
            + f"\n\n用户说：{user_text}"
        )
        reply = await _call_llm_with_retry(rendered, conversation_id=conversation_id)
        reply = await _consume_tools(
            conversation_id, customer_id, platform, rendered, reply, tool_results, tool_names,
        )
        if reply is not None and (_tool_answered(tool_names, tool_results) or reply.reply_messages):
            reply.handoff = not _tool_answered(tool_names, tool_results)
            if reply.handoff:
                reply.handoff_reason = reply.handoff_reason or "low_confidence"
            return reply
    remembered = await _reply_from_dialogue(
        conversation_id, user_text, recent, local=local, allow_owned=allow_owned)
    if remembered is not None:
        return remembered
    if owned:
        await note_unmatched(conversation_id)
        record_missed_question(user_text, platform, conversation_id)
        return ""
    return None


async def _consume_tools(conversation_id: int, customer_id: int, platform: str, rendered: str,
                         reply: AgentReply | None, tool_results: list[dict], tool_names: list[str]) -> AgentReply | None:
    tool_ctx = tools.ToolContext(conversation_id=conversation_id, customer_id=customer_id, platform=platform)
    rounds = 0
    while reply is not None and reply.tool_call and rounds < MAX_TOOL_ROUNDS:
        rounds += 1
        call = reply.tool_call
        tool_names.append(call.name)
        result = await tools.execute_tool(call.name, call.args, tool_ctx)
        tool_results.append(result)
        rendered = rendered + tools.tool_result_text(call.name, result, allow_chain=rounds < MAX_TOOL_ROUNDS)
        reply = await _call_llm_with_retry(rendered, conversation_id=conversation_id)
    return reply


def _earlier_dialogue(user_text: str, recent: list[dict]) -> list[dict]:
    """去掉当前这句。事实只留人工原话和已经核对过的 AI 回复。"""
    rows = list(recent or [])
    if rows and rows[-1].get("sender_type") == "user" and rows[-1].get("content") == user_text:
        rows = rows[:-1]
    kept = []
    for row in rows:
        content = (row.get("content") or "").strip()
        if not content:
            continue
        if row.get("sender_type") == "agent" or (row.get("sender_type") == "ai" and row.get("grounded")):
            kept.append(row)
    return kept


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
    facts = "\n".join(row["content"] for row in earlier)
    if evidence.claims_unsupported(reply.reply_messages[:1], facts):
        return None
    return await _deliver_ai(
        conversation_id, reply.reply_messages[:1], local=local, allow_owned=allow_owned,
        extra={"intent": "other", "confidence": reply.confidence, "citations": [], "from_dialogue": True, "grounded": True},
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


def _reply_with_source_list(user_text: str, contexts: list[dict], facets: list[str]) -> list[str] | None:
    """召回正文里的编号条目用原文作答，不看问法。点名一条时只发那一条。"""
    if len(facets) >= 2:
        groups: list[list[str]] = []
        for facet in facets:
            own = [item for item in contexts if pipeline.facet_covered(facet, [item])]
            chosen = _choose_numbered_items(user_text, _collect_numbered_items(own))
            if not chosen:
                return None
            groups.append(chosen)
        return [_format_source_list(items) for items in groups]
    chosen = _choose_numbered_items(user_text, _collect_numbered_items(contexts))
    if not chosen:
        return None
    return [_format_source_list(chosen)]


def _collect_numbered_items(contexts: list[dict]) -> list[str]:
    """只收这一轮召回正文里的编号条目，不去数据库补同一篇文档。"""
    seen: set[str] = set()
    items: list[str] = []
    for item in contexts or []:
        for line in _numbered_items(item.get("content") or ""):
            body = _LIST_MARKER_RE.sub("", line).strip()
            key = re.sub(r"\s+", "", body)
            if not key or key in seen:
                continue
            seen.add(key)
            items.append(line)
    return items


def _choose_numbered_items(user_text: str, items: list[str]) -> list[str] | None:
    if len(items) < 2:
        return None
    named = _items_user_named(user_text, items)
    if len(named) == 1:
        return named
    return items


def _items_user_named(user_text: str, items: list[str]) -> list[str]:
    """用户原话点到了某条正文，才算点名。"""
    compact_user = re.sub(r"\s+", "", user_text or "")
    if len(compact_user) < 4:
        return []
    named = []
    for item in items:
        body = re.sub(r"\s+", "", _LIST_MARKER_RE.sub("", item).strip())
        if len(body) < 4:
            continue
        if body in compact_user or compact_user in body:
            named.append(item)
    return named


def _has_ungrounded_amount(messages: list[str], contexts: list[dict]) -> bool:
    """回复里的数字和政策必须能在召回正文里对上。"""
    return evidence.claims_unsupported(messages, evidence.evidence_text(contexts, [], []))


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
            "facets": list(retrieval.facets),
            "gaps": list(retrieval.gaps),
        }
        msg.extra = extra
        db.commit()
    finally:
        db.close()


def _format_knowledge_context(contexts: list[dict], gaps: list[str] | None = None) -> str:
    """每条资料分开给。数字冲突时不要选边，缺口不要编。"""
    blocks = []
    for i, item in enumerate(contexts):
        blocks.append(f"【资料{i + 1}】（来源：{item['source']}）\n{item['content']}")
    if gaps:
        blocks.append("这些问题没有资料，不要编，请同事确认：" + "、".join(gaps))
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
    """主模型调用（解析失败重试 1 次）。硬失败或解析失败时，改走备用模型再试一轮。"""
    reply, hard_failed = await _call_llm_once(
        rendered_prompt, conversation_id=conversation_id,
        base_url=settings.llm_base_url, api_key=settings.llm_api_key, model=settings.llm_model,
    )
    if reply is not None or not settings.llm_fallback_configured:
        return reply
    if hard_failed:
        logger.warning("主 LLM 不可用，切换备用模型 %s", settings.llm_fallback_model)
        monitor.record("llm_failure", f"主模型 {settings.llm_model} 失败，切换备用模型")
    else:
        logger.warning("主 LLM 没有给出可用 JSON，切换备用模型 %s", settings.llm_fallback_model)
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
