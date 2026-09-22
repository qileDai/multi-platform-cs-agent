"""知识入库：多格式解析、语义切分、父子索引、增量更新。

策略：
- FAQ：问答对整体作为一个 chunk，不拆散（检索精度最高）
- 文档：先按标题/段落语义边界切分，超长再滑窗（500 字 / overlap 80）
- 父子索引：子块参与检索，命中后取父块作为生成上下文
- 增量更新：文档重新上传时旧 chunk 全部失效重建
"""
import io
import json
import logging
import re

from ..database import SessionLocal
from ..models import KnowledgeChunk, KnowledgeDoc
from . import bm25, embeddings, vectorstore

logger = logging.getLogger(__name__)

CHUNK_SIZE = 500
CHUNK_OVERLAP = 80


# ============ 文档解析 ============

def parse_file(filename: str, data: bytes) -> str:
    """按扩展名解析文档为纯文本。"""
    name = filename.lower()
    if name.endswith(".pdf"):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if name.endswith((".docx", ".doc")):
        from docx import Document
        doc = Document(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    # md / txt 及其他按纯文本处理
    return data.decode("utf-8", errors="ignore")


# ============ 切分 ============

def split_text(text: str) -> list[str]:
    """语义边界切分 + 超长滑窗。"""
    # 先按标题/空行/段落边界切
    blocks = re.split(r"\n\s*\n|(?=^#{1,6}\s)", text, flags=re.MULTILINE)
    blocks = [b.strip() for b in blocks if b and b.strip()]

    chunks: list[str] = []
    current = ""
    for block in blocks:
        if len(current) + len(block) <= CHUNK_SIZE:
            current = (current + "\n\n" + block).strip()
        else:
            if current:
                chunks.extend(_sliding_window(current))
            current = block
    if current:
        chunks.extend(_sliding_window(current))
    return [c for c in chunks if len(c) >= 10]  # 过短的碎片不索引


def _sliding_window(text: str) -> list[str]:
    if len(text) <= CHUNK_SIZE:
        return [text]
    result = []
    start = 0
    while start < len(text):
        result.append(text[start:start + CHUNK_SIZE])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return result


# ============ 入库 ============

def load_similar_questions(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [str(item).strip() for item in data if str(item).strip()]


def faq_index_text(doc: KnowledgeDoc) -> str:
    """检索用文本。相似问不写回 doc.content，避免破坏「问/答」解析。"""
    first, _, rest = (doc.content or "").partition("\n")
    question = first.removeprefix("问：")
    answer = rest.removeprefix("答：")
    similars = load_similar_questions(doc.similar_questions)
    lines = [f"问：{question}"]
    if similars:
        lines.append("相似：" + "；".join(similars))
    lines.append(f"答：{answer}")
    return "\n".join(lines)


async def ingest_faq(doc_id: int):
    """FAQ 问答对整体作为一个 chunk 索引。content 格式：第一行问题，其余为答案。"""
    db = SessionLocal()
    try:
        doc = db.get(KnowledgeDoc, doc_id)
        if doc is None or doc.status != "active":
            return
        # 清旧 chunk（增量更新）
        _delete_chunks(db, doc_id)
        chunk = KnowledgeChunk(doc_id=doc_id, parent_id=None, chunk_index=0, content=faq_index_text(doc))
        db.add(chunk)
        db.commit()
        db.refresh(chunk)
        await _index_chunks([chunk], doc)
    finally:
        db.close()


async def ingest_document(doc_id: int):
    """文档切分 + 父子索引。"""
    db = SessionLocal()
    try:
        doc = db.get(KnowledgeDoc, doc_id)
        if doc is None or doc.status != "active":
            return
        _delete_chunks(db, doc_id)

        pieces = split_text(doc.content)
        chunks = []
        for i, piece in enumerate(pieces):
            # 超过 CHUNK_SIZE 的段：自身为父块，再切子块参与检索
            if len(piece) > CHUNK_SIZE * 1.5:
                parent = KnowledgeChunk(doc_id=doc_id, parent_id=None, chunk_index=i, content=piece)
                db.add(parent)
                db.flush()
                for j, sub in enumerate(_sliding_window(piece)):
                    chunks.append(KnowledgeChunk(
                        doc_id=doc_id, parent_id=parent.id, chunk_index=i * 1000 + j, content=sub
                    ))
            else:
                chunks.append(KnowledgeChunk(doc_id=doc_id, parent_id=None, chunk_index=i, content=piece))
        db.add_all(chunks)
        db.commit()
        for c in chunks:
            db.refresh(c)
        await _index_chunks(chunks, doc)
    finally:
        db.close()


def _delete_chunks(db, doc_id: int):
    db.query(KnowledgeChunk).filter(KnowledgeChunk.doc_id == doc_id).delete()
    db.commit()
    try:
        vectorstore.delete_by_doc(doc_id)
    except Exception:  # noqa: BLE001
        logger.warning("向量库删除 doc_id=%s 失败（可能未启用 embedding）", doc_id)


async def _index_chunks(chunks: list[KnowledgeChunk], doc: KnowledgeDoc):
    """写入向量库（可降级）并重建 BM25。"""
    # 向量索引
    vectors = await embeddings.embed_texts([c.content for c in chunks])
    if vectors is not None:
        vectorstore.upsert_chunks(
            ids=[f"chunk_{c.id}" for c in chunks],
            embeddings=vectors,
            documents=[c.content for c in chunks],
            metadatas=[{"doc_id": doc.id, "chunk_id": c.id, "parent_id": c.parent_id or 0,
                        "title": doc.title} for c in chunks],
        )
    # BM25 全量重建（内存索引，规模小可接受）
    rebuild_bm25_from_db()


def rebuild_bm25_from_db():
    """从 DB 全量重建 BM25 索引（启动时/知识变更后调用）。"""
    db = SessionLocal()
    try:
        rows = (
            db.query(KnowledgeChunk)
            .join(KnowledgeDoc, KnowledgeDoc.id == KnowledgeChunk.doc_id)
            .filter(KnowledgeDoc.status == "active")
            .all()
        )
        bm25.rebuild([
            {"chunk_id": f"chunk_{c.id}", "doc_id": c.doc_id, "content": c.content}
            for c in rows
        ])
    finally:
        db.close()
