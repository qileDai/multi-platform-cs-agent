"""Rerank 精排：bge-reranker（OpenAI 兼容的 /rerank 接口，硅基流动等支持）。未配置时跳过精排。"""
import logging

import httpx

from ..config import settings

logger = logging.getLogger(__name__)


async def rerank(query: str, documents: list[str], top_n: int = 3) -> list[dict] | None:
    """对候选文档精排。返回 [{index, score}] 按分数降序；未配置/失败返回 None（上层用融合序兜底）。"""
    if not settings.rerank_configured or not documents:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{settings.rerank_base_url.rstrip('/')}/rerank",
                headers={"Authorization": f"Bearer {settings.rerank_api_key}"},
                json={
                    "model": settings.rerank_model,
                    "query": query,
                    "documents": documents,
                    "top_n": min(top_n, len(documents)),
                },
            )
            data = resp.json()
        results = data.get("results", [])
        return sorted(
            [{"index": r["index"], "score": r.get("relevance_score", 0.0)} for r in results],
            key=lambda x: x["score"], reverse=True,
        )
    except Exception:  # noqa: BLE001
        logger.exception("Rerank 调用失败，跳过精排")
        return None
