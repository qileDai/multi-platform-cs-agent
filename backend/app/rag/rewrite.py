"""查询改写：多轮对话指代消解 + 同义多路召回。

把「那这个多少钱」结合历史改写成独立完整问题，并生成 1~2 个同义改写。
LLM 未配置，或历史里除当前这句外没有更早的消息时，直接返回原查询。
"""
import json
import logging

from openai import AsyncOpenAI

from ..config import settings

logger = logging.getLogger(__name__)

_REWRITE_HEAD = (
    "你是查询改写助手。根据对话历史，把用户最新问题改写成一个独立完整的检索问题"
    "（补全指代和省略），再给出 1 个同义改写版本。\n"
    "只输出 JSON："
)
_REWRITE_JSON = '{"standalone": "独立完整问题", "variants": ["同义改写"]}'


def _earlier_history(query: str, history: list[dict]) -> list[dict]:
    """去掉当前这句，只留更早的轮次。历史本身不含当前句时原样返回。"""
    if not history:
        return []
    last = history[-1]
    if last.get("sender_type") == "user" and last.get("content") == query:
        return history[:-1]
    return list(history)


def _render_prompt(history_text: str, query: str) -> str:
    # 不用 str.format：示例 JSON 里的花括号会被当成占位符，抛 KeyError。
    return (
        _REWRITE_HEAD
        + _REWRITE_JSON
        + "\n\n对话历史：\n"
        + history_text
        + "\n\n用户最新问题："
        + query
    )


async def rewrite_query(query: str, history: list[dict]) -> list[str]:
    """返回改写后的查询列表（含原查询）。失败/未配置/没有更早历史时返回 [query]。"""
    earlier = _earlier_history(query, history)
    if not settings.llm_configured or not earlier:
        return [query]
    try:
        history_text = "\n".join(
            f"{'用户' if h['sender_type'] == 'user' else '客服'}: {h['content']}"
            for h in earlier[-6:]
        )
        client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
        resp = await client.chat.completions.create(
            model=settings.llm_model,
            messages=[{"role": "user", "content": _render_prompt(history_text, query)}],
            temperature=0,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content)
        queries = [data.get("standalone") or query]
        queries.extend(v for v in (data.get("variants") or []) if v)
        queries.append(query)
        # 去重保序
        seen, result = set(), []
        for q in queries:
            if q and q not in seen:
                seen.add(q)
                result.append(q)
        return result[:3]
    except Exception:  # noqa: BLE001
        logger.exception("查询改写失败，使用原查询")
        return [query]
