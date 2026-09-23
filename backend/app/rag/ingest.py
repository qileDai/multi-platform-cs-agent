"""知识入库：多格式解析、按小节切分、父子索引、增量更新。

策略：
- FAQ：问答对整体作为一个 chunk，不拆散（检索精度最高）
- 文档：按 Markdown 标题和空行切成小节，标题留在该节正文前
- 小节不超过 500 字：整节入库，检索文本前加文档标题
- 超长小节：父块存全文，只把带标题的子块送进向量库和 BM25（500 字 / 重叠 80，尽量在句号处断开）
- 增量更新：文档重新上传时旧 chunk 全部失效重建
"""
import io
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from ..config import settings
from ..database import SessionLocal
from ..models import KnowledgeChunk, KnowledgeDoc
from . import bm25, embeddings, vectorstore

logger = logging.getLogger(__name__)

CHUNK_SIZE = 500
CHUNK_OVERLAP = 80
INDEX_VERSION = "2"  # 切块策略变化时递增，启动时触发重建

_HEADING_RE = re.compile(r"^#{1,6}\s+\S")
_SENTENCE_MARKS = ("。", "！", "？", "；", "\n")


@dataclass
class Section:
    heading: str
    text: str  # 标题 + 正文，标题在前


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
    """按小节切分。超长小节保持整节，滑窗在入库时再做。"""
    return [section.text for section in split_sections(text)]


def split_sections(text: str) -> list[Section]:
    """按 Markdown 标题和空行切成小节，标题跟随其后的正文。过短碎片不返回。"""
    sections: list[Section] = []
    heading = ""
    for block in re.split(r"\n\s*\n", text.strip()):
        block = block.strip()
        if not block:
            continue
        buf: list[str] = []
        for line in block.splitlines():
            stripped = line.strip()
            if _HEADING_RE.match(stripped):
                _flush_section(sections, heading, buf)
                heading = stripped
                continue
            buf.append(line)
        _flush_section(sections, heading, buf)
    return sections


def _flush_section(sections: list[Section], heading: str, buf: list[str]) -> None:
    body = "\n".join(buf).strip()
    buf.clear()
    if not body:
        return
    text = f"{heading}\n{body}" if heading else body
    if len(text) < 10:
        return
    sections.append(Section(heading=heading, text=text))


def _sliding_window(text: str) -> list[str]:
    """滑窗切分。窗口末尾尽量落在句号上，避免把一句话切成两半。"""
    if len(text) <= CHUNK_SIZE:
        return [text]
    result = []
    start = 0
    while start < len(text):
        hard_end = min(start + CHUNK_SIZE, len(text))
        end = hard_end
        if hard_end < len(text):
            window = text[start:hard_end]
            cut = max(window.rfind(mark) for mark in _SENTENCE_MARKS)
            if cut >= int(CHUNK_SIZE * 0.6):
                end = start + cut + 1
        piece = text[start:end].strip()
        if piece:
            result.append(piece)
        if end >= len(text):
            break
        next_start = end - CHUNK_OVERLAP
        if next_start <= start:
            next_start = end
        start = next_start
    return result


def _index_text(doc_title: str, heading: str, text: str) -> str:
    """检索文本带上文档标题和小节标题，后半段窗口也不会丢掉主题。"""
    body = text
    if heading and body.startswith(heading):
        body = body[len(heading):].lstrip("\n")
    parts = [f"【{doc_title}】"]
    if heading:
        parts.append(heading)
    if body:
        parts.append(body)
    return "\n".join(parts)


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
    """文档按小节切分。超长小节建父块，只索引带标题的子块。"""
    db = SessionLocal()
    try:
        doc = db.get(KnowledgeDoc, doc_id)
        if doc is None or doc.status != "active":
            return
        _delete_chunks(db, doc_id)

        index_chunks: list[KnowledgeChunk] = []
        for i, section in enumerate(split_sections(doc.content or "")):
            if len(section.text) <= CHUNK_SIZE:
                index_chunks.append(KnowledgeChunk(
                    doc_id=doc_id, parent_id=None, chunk_index=i,
                    content=_index_text(doc.title, section.heading, section.text),
                ))
                continue
            parent = KnowledgeChunk(
                doc_id=doc_id, parent_id=None, chunk_index=i, content=section.text,
            )
            db.add(parent)
            db.flush()
            for j, window in enumerate(_sliding_window(section.text)):
                index_chunks.append(KnowledgeChunk(
                    doc_id=doc_id, parent_id=parent.id, chunk_index=i * 1000 + j,
                    content=_index_text(doc.title, section.heading, window),
                ))
        db.add_all(index_chunks)
        db.commit()
        for chunk in index_chunks:
            db.refresh(chunk)
        await _index_chunks(index_chunks, doc)
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
    """写入向量库（可降级）并重建 BM25。父块不进索引。"""
    if not chunks:
        rebuild_bm25_from_db()
        return
    vectors = await embeddings.embed_texts([c.content for c in chunks])
    if vectors is not None:
        vectorstore.upsert_chunks(
            ids=[f"chunk_{c.id}" for c in chunks],
            embeddings=vectors,
            documents=[c.content for c in chunks],
            metadatas=[{"doc_id": doc.id, "chunk_id": c.id, "parent_id": c.parent_id or 0,
                        "title": doc.title} for c in chunks],
        )
    rebuild_bm25_from_db()


def _indexable(rows: list[KnowledgeChunk]) -> list[KnowledgeChunk]:
    """有子块的父块只用于生成上下文，不参与检索。"""
    parent_ids = {row.parent_id for row in rows if row.parent_id}
    return [row for row in rows if row.id not in parent_ids]


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
            for c in _indexable(rows)
        ])
    finally:
        db.close()


def _index_version_path() -> Path:
    return Path(settings.chroma_dir) / "index_version.txt"


def index_version_stale() -> bool:
    path = _index_version_path()
    if not path.is_file():
        return True
    return path.read_text(encoding="utf-8").strip() != INDEX_VERSION


def _write_index_version() -> None:
    path = _index_version_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(INDEX_VERSION, encoding="utf-8")


async def reindex_all() -> None:
    """切块版本变化后，重嵌入全部生效文档。失败则不写版本号，下次启动再试。"""
    db = SessionLocal()
    try:
        docs = (
            db.query(KnowledgeDoc)
            .filter(KnowledgeDoc.status == "active")
            .all()
        )
        jobs = [(doc.id, doc.doc_type) for doc in docs]
    finally:
        db.close()
    logger.info("开始重建知识库索引，版本 %s，文档 %d 篇", INDEX_VERSION, len(jobs))
    for doc_id, doc_type in jobs:
        try:
            if doc_type == "faq":
                await ingest_faq(doc_id)
            else:
                await ingest_document(doc_id)
        except Exception:  # noqa: BLE001
            logger.exception("重建文档失败 doc_id=%s，保留旧索引版本以便重试", doc_id)
            return
    _write_index_version()
    logger.info("知识库索引已重建到版本 %s", INDEX_VERSION)
