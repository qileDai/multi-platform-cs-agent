"""查询改写：多轮对话指代消解 + 同义多路召回。

把「那这个多少钱」结合历史改写成独立完整问题，并生成 1~2 个同义改写。
LLM 未配置时直接返回原查询（降级）。
"""
import logging

from openai import AsyncOpenAI

from ..config import settings

logger = logging.getLogger(__name__)

REWRITE_PROMPT = """你是查询改写助手。根据对话历史，把用户最新问题改写成一个独立完整的检索问题（补全指代和省略），再给出 1 个同义改写版本。
只输出 JSON：{"standalone": "独立完整问题", "variants": ["同义改写"]}

对话历史：
{history}

用户最新问题：{query}"""


async def rewrite_query(query: str, history: list[dict]) -> list[str]:
    """返回改写后的查询列表（含原查询）。失败/未配置时返回 [query]。"""
    if not settings.llm_configured or not history:
        return [query]
    try:
        history_text = "\n".join(
            f"{'用户' if h['sender_type'] == 'user' else '客服'}: {h['content']}"
            for h in history[-6:]
        )
        client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
        resp = await client.chat.completions.create(
            model=settings.llm_model,
            messages=[{"role": "user", "content": REWRITE_PROMPT.format(history=history_text, query=query)}],
            temperature=0,
            response_format={"type": "json_object"},
        )
        import json
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
