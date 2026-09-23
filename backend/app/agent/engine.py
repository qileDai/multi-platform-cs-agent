"""Agent 引擎：提示词渲染 → LLM 调用 → 契约校验 → 工具调用（两阶段）→ 动作执行。

动作：分条发送回复 / 打标签 / 留资提取 / 转人工 / 业务工具调用（查订单/查物流/建工单）。
工具调用循环：LLM 输出 tool_call → 执行工具 → 结果回填提示词 → 二次生成，最多 2 次防死循环。
LLM 未配置时降级：固定话术 + 直接转人工，保证全流程可跑通。
主模型硬失败（网络/服务异常）时自动切换备用模型（LLM_FALLBACK_*）。
"""
import json
import logging
from datetime import datetime

from openai import AsyncOpenAI
from pydantic import ValidationError

from ..config import settings
from ..core import monitor
from ..database import SessionLocal
from ..models import Conversation, Customer, KnowledgeDoc, LlmUsage, Message
from ..rag import pipeline
from ..schemas import AgentReply
from ..services import record_missed_question, send_outbound, handoff
from . import context, humanize, prompt as prompt_mod, tools

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 2  # 工具调用上限（防死循环）


async def process_ai_reply(conversation_id: int, *, local: bool = False) -> str:
    """对一条用户消息执行完整 AI 接待流程。

    local=True 时只在本系统入库并返回拼成一段的正文，不走平台发送，也不做打字延迟。
    供知你快回同步回复接口使用。默认路径的返回值可忽略。
    """
    db = SessionLocal()
    try:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or conversation.mode != "ai" or conversation.status != "open":
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
    finally:
        db.close()

    # LLM 未配置：降级话术 + 转人工
    if not settings.llm_configured:
        text = await _deliver_ai(
            conversation_id_, ["这会儿咨询有点多，我先帮您叫同事过来哈"], local=local)
        await handoff(conversation_id_, reason="llm_not_configured")
        return text

    # 1. 上下文窗口
    history_text, recent = context.get_history_for_prompt(conversation_id_)

    # 2. RAG 检索。未过阈值：固定安抚话术 + 硬转人工，不把「无匹配资料」交给 LLM 编答案。
    retrieval = await pipeline.retrieve(user_text, history=recent)
    if not retrieval.passed:
        record_missed_question(user_text, platform, conversation_id_)
        text = await _deliver_ai(
            conversation_id_,
            ["这个问题我这边没查到靠谱资料，先帮您转给同事哈"],
            local=local,
            extra={"intent": "other", "confidence": 0.0, "citations": []},
        )
        await handoff(conversation_id_, reason="low_confidence")
        return text
    knowledge_context = _format_knowledge_context(retrieval.contexts)

    # 3. 渲染提示词 + 调用 LLM（失败重试 1 次，主模型硬失败自动切备用）
    rendered = prompt_mod.render_prompt(
        platform=platform,
        knowledge_context=knowledge_context,
        history_text=history_text,
        user_message=user_text,
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
            conversation_id_, ["不好意思，我这边卡了一下"], local=local)
        reason = "llm_parse_failed" if reply is None else "tool_rounds_exhausted"
        await handoff(conversation_id_, reason=reason)
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
            text = await _deliver_ai(conversation_id_, reply.reply_messages, local=local, extra=extra)
            _bump_knowledge_hits(retrieval.contexts)
        await handoff(conversation_id_, reason=reply.handoff_reason or "unknown")
        return text

    # 6. 正常回复（拟人化分条发送；知你快回通道拼成一段本地入库）
    text = ""
    if reply.reply_messages:
        text = await _deliver_ai(conversation_id_, reply.reply_messages, local=local, extra=extra)
        _bump_knowledge_hits(retrieval.contexts)

    # 7. 滚动小结（后台，不阻塞）
    await context.maybe_update_summary(conversation_id_)
    return text


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
                      extra: dict | None = None) -> str:
    """发出 AI 正文。local 时拼成一条本地消息并返回实际入库文本。"""
    parts = [m.strip() for m in messages if isinstance(m, str) and m.strip()]
    if not parts:
        return ""
    if local:
        from ..services import record_local_ai_message
        saved = await record_local_ai_message(conversation_id, "\n".join(parts)[:4000], extra)
        return saved.content if saved is not None else ""
    if len(parts) == 1:
        await send_outbound(conversation_id, parts[0], sender_type="ai", extra=extra)
        return ""
    await _send_replies(conversation_id, parts, extra or {})
    return ""


async def _send_replies(conversation_id: int, messages: list[str], extra: dict):
    async def _send(content: str) -> bool:
        sent = await send_outbound(conversation_id, content, sender_type="ai", extra=extra)
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
