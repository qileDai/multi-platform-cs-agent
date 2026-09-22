"""Chroma 向量库封装：本地持久化，零运维。接口抽象，未来可平滑迁移 Milvus。"""
import logging

import chromadb

from ..config import settings

logger = logging.getLogger(__name__)

_client: chromadb.PersistentClient | None = None
_collection = None
COLLECTION_NAME = "knowledge_chunks"


def _get_collection():
    global _client, _collection
    if _collection is None:
        _client = chromadb.PersistentClient(path=settings.chroma_dir)
        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME, metadata={"hnsw:space": "cosine"}
        )
    return _collection


def upsert_chunks(ids: list[str], embeddings: list[list[float]],
                  documents: list[str], metadatas: list[dict]):
    collection = _get_collection()
    collection.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)


def delete_by_doc(doc_id: int):
    collection = _get_collection()
    collection.delete(where={"doc_id": doc_id})


def query(query_embedding: list[float], top_k: int = 20) -> list[dict]:
    """向量检索。返回 [{chunk_id, doc_id, content, score}]，score 为余弦相似度（越大越好）。"""
    collection = _get_collection()
    if collection.count() == 0:
        return []
    result = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(top_k, collection.count()),
        include=["documents", "metadatas", "distances"],
    )
    hits = []
    for i, chunk_id in enumerate(result["ids"][0]):
        distance = result["distances"][0][i]
        hits.append({
            "chunk_id": chunk_id,
            "doc_id": result["metadatas"][0][i].get("doc_id"),
            "content": result["documents"][0][i],
            "score": 1.0 - distance,  # cosine distance -> similarity
        })
    return hits


def total_chunks() -> int:
    return _get_collection().count()
