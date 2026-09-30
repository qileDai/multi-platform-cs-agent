"""知识库接口：FAQ CRUD、文档上传、召回测试台、未命中问题、违禁词库。"""
import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..core import audit
from ..database import get_db
from ..models import Agent, BannedWord, KnowledgeChunk, KnowledgeDoc, MissedQuestion
from ..rag import ingest, pipeline
from ..rag.ingest import load_similar_questions
from ..schemas import (BannedWordIn, BannedWordOut, DocMetaUpdate, DocStatusUpdate, FaqCreate, FaqUpdate,
                       KnowledgeChunkOut, KnowledgeDocOut, MissedQuestionOut, RecallTestRequest,
                       RecallTestResult)
from .deps import get_current_agent, require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


def _parse_faq(content: str) -> tuple[str, str]:
    first, _, rest = (content or "").partition("\n")
    question = first.removeprefix("问：")
    answer = rest.removeprefix("答：")
    return question, answer


def _dump_similar(items: list[str] | None) -> str:
    cleaned = [s.strip() for s in (items or []) if s and s.strip()]
    return json.dumps(cleaned, ensure_ascii=False)


def _doc_out(db: Session, doc: KnowledgeDoc) -> KnowledgeDocOut:
    count = db.query(KnowledgeChunk).filter(KnowledgeChunk.doc_id == doc.id).count()
    question, answer = _parse_faq(doc.content) if doc.doc_type == "faq" else ("", "")
    return KnowledgeDocOut(
        id=doc.id, title=doc.title, doc_type=doc.doc_type, status=doc.status,
        version=doc.version, chunk_count=count, question=question, answer=answer,
        category=doc.category or "未分类",
        similar_questions=load_similar_questions(doc.similar_questions),
        hit_count=doc.hit_count or 0,
        created_at=doc.created_at, updated_at=doc.updated_at,
    )


# ============ FAQ ============

@router.get("/docs", response_model=list[KnowledgeDocOut])
def list_docs(agent: Agent = Depends(get_current_agent), db: Session = Depends(get_db)):
    docs = db.query(KnowledgeDoc).order_by(KnowledgeDoc.updated_at.desc()).all()
    return [_doc_out(db, d) for d in docs]


@router.post("/faq", response_model=KnowledgeDocOut)
async def create_faq(req: FaqCreate, agent: Agent = Depends(get_current_agent),
                     db: Session = Depends(get_db)):
    doc = KnowledgeDoc(
        title=req.title, doc_type="faq",
        content=f"问：{req.question}\n答：{req.answer}",
        category=(req.category or "未分类").strip() or "未分类",
        similar_questions=_dump_similar(req.similar_questions),
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    audit.log(db, agent, "kb_faq_create", target=f"doc:{doc.id}", detail=req.title)
    await ingest.ingest_faq(doc.id)
    return _doc_out(db, doc)


@router.put("/faq/{doc_id}", response_model=KnowledgeDocOut)
async def update_faq(doc_id: int, req: FaqUpdate, agent: Agent = Depends(get_current_agent),
                     db: Session = Depends(get_db)):
    doc = db.get(KnowledgeDoc, doc_id)
    if doc is None or doc.doc_type != "faq":
        raise HTTPException(404, "FAQ 不存在")
    # content 格式：第一行「问：xxx」，其余「答：xxx」
    question = req.question if req.question is not None else doc.content.split("\n")[0].removeprefix("问：")
    answer = req.answer if req.answer is not None else doc.content.split("\n", 1)[1].removeprefix("答：") if "\n" in doc.content else ""
    doc.content = f"问：{question}\n答：{answer}"
    if req.title:
        doc.title = req.title
    if req.category is not None:
        doc.category = req.category.strip() or "未分类"
    if req.similar_questions is not None:
        doc.similar_questions = _dump_similar(req.similar_questions)
    doc.version += 1
    doc.updated_at = datetime.utcnow()
    db.commit()
    audit.log(db, agent, "kb_faq_update", target=f"doc:{doc.id}", detail=doc.title)
    await ingest.ingest_faq(doc.id)  # 增量重建索引
    return _doc_out(db, doc)


@router.delete("/docs/{doc_id}")
def delete_doc(doc_id: int, agent: Agent = Depends(get_current_agent),
               db: Session = Depends(get_db)):
    doc = db.get(KnowledgeDoc, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    doc.status = "archived"
    db.commit()
    audit.log(db, agent, "kb_doc_delete", target=f"doc:{doc_id}", detail=doc.title)
    ingest._delete_chunks(db, doc_id)
    ingest.rebuild_bm25_from_db()
    return {"ok": True}


@router.patch("/docs/{doc_id}", response_model=KnowledgeDocOut)
async def update_doc_meta(doc_id: int, req: DocMetaUpdate, agent: Agent = Depends(get_current_agent),
                          db: Session = Depends(get_db)):
    """文档（及 FAQ）的标题、分类。标题变更且仍启用时重建索引，分类不进检索。"""
    doc = db.get(KnowledgeDoc, doc_id)
    if doc is None or doc.status == "archived":
        raise HTTPException(404, "文档不存在")
    title_changed = False
    if req.title is not None and req.title.strip():
        title_changed = req.title.strip() != doc.title
        doc.title = req.title.strip()
    if req.category is not None:
        doc.category = req.category.strip() or "未分类"
    doc.updated_at = datetime.utcnow()
    db.commit()
    audit.log(db, agent, "kb_doc_meta", target=f"doc:{doc.id}", detail=doc.title)
    if title_changed and doc.status == "active":
        if doc.doc_type == "faq":
            await ingest.ingest_faq(doc.id)
        else:
            await ingest.ingest_document(doc.id)
    return _doc_out(db, doc)


@router.patch("/docs/{doc_id}/status", response_model=KnowledgeDocOut)
async def set_doc_status(doc_id: int, req: DocStatusUpdate, agent: Agent = Depends(get_current_agent),
                         db: Session = Depends(get_db)):
    doc = db.get(KnowledgeDoc, doc_id)
    if doc is None or doc.status == "archived":
        raise HTTPException(404, "文档不存在")
    if req.status not in ("active", "disabled"):
        raise HTTPException(400, "状态只能是启用或停用")
    doc.updated_at = datetime.utcnow()
    if req.status == "disabled":
        doc.status = "disabled"
        db.commit()
        ingest._delete_chunks(db, doc.id)
        ingest.rebuild_bm25_from_db()
    else:
        doc.status = "active"
        db.commit()
        if doc.doc_type == "faq":
            await ingest.ingest_faq(doc.id)
        else:
            await ingest.ingest_document(doc.id)
    audit.log(db, agent, "kb_doc_status", target=f"doc:{doc.id}", detail=req.status)
    return _doc_out(db, doc)


@router.get("/docs/{doc_id}/chunks", response_model=list[KnowledgeChunkOut])
def list_chunks(doc_id: int, agent: Agent = Depends(get_current_agent),
                db: Session = Depends(get_db)):
    doc = db.get(KnowledgeDoc, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    rows = (
        db.query(KnowledgeChunk)
        .filter(KnowledgeChunk.doc_id == doc_id)
        .order_by(KnowledgeChunk.chunk_index)
        .all()
    )
    return [
        KnowledgeChunkOut(id=c.id, chunk_index=c.chunk_index, parent_id=c.parent_id, content=c.content)
        for c in rows
    ]


# ============ 文档上传 ============

@router.post("/upload", response_model=KnowledgeDocOut)
async def upload_doc(file: UploadFile, agent: Agent = Depends(get_current_agent),
                     db: Session = Depends(get_db)):
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(400, "文件不能超过 10MB")
    try:
        text = ingest.parse_file(file.filename or "unknown.txt", data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"文档解析失败: {exc}")
    if not text.strip():
        raise HTTPException(400, "文档内容为空")

    doc = KnowledgeDoc(title=file.filename or "未命名文档", doc_type="file", content=text)
    db.add(doc)
    db.commit()
    db.refresh(doc)
    audit.log(db, agent, "kb_doc_upload", target=f"doc:{doc.id}", detail=doc.title)
    await ingest.ingest_document(doc.id)
    return _doc_out(db, doc)


# ============ 召回测试台 ============

@router.post("/recall-test", response_model=RecallTestResult)
async def recall_test(req: RecallTestRequest, agent: Agent = Depends(get_current_agent)):
    result = await pipeline.retrieve(req.query, history=[])
    return RecallTestResult(
        rewritten_queries=result.rewritten_queries,
        hits=result.contexts,
        rerank_top_score=result.rerank_top_score,
        threshold=settings.rag_rerank_threshold,
        passed=result.passed,
        degraded=result.degraded,
    )


# ============ 未命中问题 ============

@router.get("/missed", response_model=list[MissedQuestionOut])
def list_missed(agent: Agent = Depends(get_current_agent), db: Session = Depends(get_db)):
    rows = (
        db.query(MissedQuestion)
        .filter(MissedQuestion.status == "pending")
        .order_by(MissedQuestion.count.desc())
        .limit(100)
        .all()
    )
    return [MissedQuestionOut.model_validate(r) for r in rows]


@router.post("/missed/{missed_id}/resolve")
async def resolve_missed(missed_id: int, req: FaqCreate,
                         agent: Agent = Depends(get_current_agent), db: Session = Depends(get_db)):
    """未命中问题一键转 FAQ。"""
    missed = db.get(MissedQuestion, missed_id)
    if missed is None:
        raise HTTPException(404, "记录不存在")
    doc = KnowledgeDoc(
        title=req.title, doc_type="faq",
        content=f"问：{req.question}\n答：{req.answer}",
        category=(req.category or "未分类").strip() or "未分类",
        similar_questions=_dump_similar(req.similar_questions),
    )
    db.add(doc)
    missed.status = "resolved"
    db.commit()
    db.refresh(doc)
    await ingest.ingest_faq(doc.id)
    return {"ok": True, "doc_id": doc.id}


# ============ 违禁词库 ============

@router.get("/banned-words", response_model=list[BannedWordOut])
def list_banned(agent: Agent = Depends(get_current_agent), db: Session = Depends(get_db)):
    return [BannedWordOut.model_validate(w) for w in db.query(BannedWord).all()]


@router.post("/banned-words", response_model=BannedWordOut)
def add_banned(req: BannedWordIn, agent: Agent = Depends(require_admin),
               db: Session = Depends(get_db)):
    word = BannedWord()
    _apply_banned(word, req)
    db.add(word)
    _commit_banned(db)
    db.refresh(word)
    _reload_banned_words(db)
    return word


@router.put("/banned-words/{word_id}", response_model=BannedWordOut)
def update_banned(word_id: int, req: BannedWordIn, agent: Agent = Depends(require_admin),
                  db: Session = Depends(get_db)):
    word = db.get(BannedWord, word_id)
    if word is None:
        raise HTTPException(404, "不存在")
    _apply_banned(word, req)
    _commit_banned(db)
    db.refresh(word)
    _reload_banned_words(db)
    return word


@router.delete("/banned-words/{word_id}")
def delete_banned(word_id: int, agent: Agent = Depends(require_admin),
                  db: Session = Depends(get_db)):
    word = db.get(BannedWord, word_id)
    if word:
        db.delete(word)
        db.commit()
        _reload_banned_words(db)
    return {"ok": True}


def _apply_banned(word: BannedWord, req: BannedWordIn) -> None:
    text = (req.word or "").strip()
    if not text:
        raise HTTPException(400, "违禁词不能为空")
    word.word = text
    word.category = (req.category or "极限词").strip() or "极限词"
    word.direction = req.direction


def _commit_banned(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该违禁词已存在")


def _reload_banned_words(db: Session):
    from ..core import contentfilter
    contentfilter.load_db_words(
        [(w.word, w.category, w.direction or "out") for w in db.query(BannedWord).all()])
