"""RAG 检索管线：查询改写 → 混合召回（向量+BM25）→ RRF 融合 → Rerank 精排 → 阈值兜底。"""
import logging
from dataclasses import dataclass, field

from ..config import settings
from ..database import SessionLocal
from ..models import KnowledgeChunk, KnowledgeDoc
from . import bm25, embeddings, rerank, rewrite, vectorstore

logger = logging.getLogger(__name__)

RRF_K = 60  # RRF 平滑常数


@dataclass
class RetrievalResult:
    contexts: list[dict] = field(default_factory=list)  # [{content, source, score}]
    rewritten_queries: list[str] = field(default_factory=list)
    rerank_top_score: float | None = None
    passed: bool = False
    degraded: bool = False  # 纯 BM25 降级模式


async def retrieve(query: str, history: list[dict] | None = None, top_k: int = 3) -> RetrievalResult:
    """完整检索管线。返回带引用的知识片段；未过阈值时 passed=False（上层触发转人工）。"""
    result = RetrievalResult()

    # 1. 查询改写（指代消解 + 多路召回）
    queries = await rewrite.rewrite_query(query, history or [])
    result.rewritten_queries = queries

    # 2. 多路召回：dense + sparse
    dense_hits: list[dict] = []
    query_vec = await embeddings.embed_query(queries[0])
    if query_vec is not None:
        dense_hits = vectorstore.query(query_vec, top_k=20)
    else:
        result.degraded = True

    sparse_hits: list[dict] = []
    for q in queries:
        sparse_hits.extend(bm25.query(q, top_k=20))

    if not dense_hits and not sparse_hits:
        return result

    # 3. RRF 融合
    fused = _rrf_fuse([dense_hits, sparse_hits])
    candidates = fused[:20]

    # 4. Rerank 精排
    reranked = await rerank.rerank(queries[0], [c["content"] for c in candidates], top_n=top_k)
    if reranked:
        top = [
            {**candidates[r["index"]], "score": r["score"]} for r in reranked
        ]
        result.rerank_top_score = top[0]["score"] if top else None
    else:
        # 无 rerank：融合序取 TopK。纯 BM25 降级保留命中（测试/无 Embedding Key）；
        # 有向量但精排失败时记 0 分，走阈值失败，避免弱命中当通过。
        top = candidates[:top_k]
        result.rerank_top_score = None if result.degraded else 0.0

    # 5. 阈值兜底
    if result.rerank_top_score is not None and result.rerank_top_score < settings.rag_rerank_threshold:
        result.passed = False
        return result

    # 6. 父子索引：命中子块取父块作为上下文
    result.contexts = [_resolve_parent(c) for c in top]
    result.passed = bool(result.contexts)
    return result


def _rrf_fuse(rankings: list[list[dict]]) -> list[dict]:
    """Reciprocal Rank Fusion 融合多路召回。"""
    scores: dict[str, float] = {}
    items: dict[str, dict] = {}
    for ranking in rankings:
        for rank, hit in enumerate(ranking):
            key = hit["chunk_id"]
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
            items.setdefault(key, hit)
    fused = sorted(items.values(), key=lambda h: scores[h["chunk_id"]], reverse=True)
    for hit in fused:
        hit["rrf_score"] = scores[hit["chunk_id"]]
    return fused


def _resolve_parent(hit: dict) -> dict:
    """子块命中时取父块内容；同时带上来源信息。"""
    db = SessionLocal()
    try:
        chunk_id = int(str(hit["chunk_id"]).replace("chunk_", ""))
        chunk = db.get(KnowledgeChunk, chunk_id)
        if chunk is None:
            return {"content": hit["content"], "source": "未知", "score": hit.get("score")}
        content = chunk.content
        if chunk.parent_id:
            parent = db.get(KnowledgeChunk, chunk.parent_id)
            if parent:
                content = parent.content
        doc = db.get(KnowledgeDoc, chunk.doc_id)
        return {
            "content": content,
            "source": doc.title if doc else f"doc#{chunk.doc_id}",
            "doc_id": doc.id if doc else chunk.doc_id,
            "score": hit.get("score"),
        }
    finally:
        db.close()
