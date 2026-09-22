"""Embedding：OpenAI 兼容接口（默认硅基流动 bge-m3）。未配置时返回 None，上层降级纯 BM25。"""
import logging

from openai import AsyncOpenAI

from ..config import settings

logger = logging.getLogger(__name__)


def _client() -> AsyncOpenAI | None:
    if not settings.embedding_configured:
        return None
    return AsyncOpenAI(base_url=settings.embedding_base_url, api_key=settings.embedding_api_key)


async def embed_texts(texts: list[str]) -> list[list[float]] | None:
    """批量向量化。未配置或调用失败返回 None（降级信号）。"""
    client = _client()
    if client is None:
        return None
    try:
        resp = await client.embeddings.create(model=settings.embedding_model, input=texts)
        return [item.embedding for item in resp.data]
    except Exception:  # noqa: BLE001
        logger.exception("Embedding 调用失败，降级纯 BM25")
        return None


async def embed_query(text: str) -> list[float] | None:
    result = await embed_texts([text])
    return result[0] if result else None
