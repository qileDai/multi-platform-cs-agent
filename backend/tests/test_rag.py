"""RAG 管线测试（纯 BM25 降级模式，不依赖外部 API）。"""
import pytest
import pytest_asyncio

from app.models import KnowledgeDoc
from app.rag import ingest, pipeline, bm25


@pytest_asyncio.fixture()
async def faq_doc(db):
    doc = KnowledgeDoc(title="产品价格", doc_type="faq",
                       content="问：这个多少钱\n答：标准款 99 元，两件九折。")
    db.add(doc)
    db.commit()
    db.refresh(doc)
    await ingest.ingest_faq(doc.id)
    yield doc
    doc.status = "archived"
    db.commit()
    ingest.rebuild_bm25_from_db()


class TestSplitText:
    def test_short_text_single_chunk(self):
        assert ingest.split_text("这是一段很短的内容。") == ["这是一段很短的内容。"]

    def test_long_text_split_with_overlap(self):
        text = "段落一。" * 200 + "\n\n" + "段落二。" * 200
        chunks = ingest.split_text(text)
        assert len(chunks) >= 2
        assert all(len(c) <= ingest.CHUNK_SIZE for c in chunks)

    def test_tiny_fragments_dropped(self):
        assert ingest.split_text("嗯。\n\n啊。") == []


class TestPipeline:
    @pytest.mark.asyncio
    async def test_faq_recall_hit(self, faq_doc):
        """FAQ 入库后可召回。"""
        result = await pipeline.retrieve("多少钱", history=[])
        assert result.passed is True
        assert len(result.contexts) > 0
        assert "99" in result.contexts[0]["content"]
        assert result.contexts[0]["source"] == "产品价格"
        assert result.degraded is True  # 测试环境未配置 embedding

    @pytest.mark.asyncio
    async def test_no_hit_when_knowledge_empty(self, faq_doc):
        """知识库无相关内容时判定无命中。"""
        result = await pipeline.retrieve("火星移民政策是什么", history=[])
        assert result.passed is False
        assert result.contexts == []

    @pytest.mark.asyncio
    async def test_rrf_fusion(self):
        """RRF 融合：两路都命中的排最前。"""
        rankings = [
            [{"chunk_id": "a", "content": "x", "score": 0.9}, {"chunk_id": "b", "content": "y", "score": 0.8}],
            [{"chunk_id": "b", "content": "y", "score": 5.0}, {"chunk_id": "c", "content": "z", "score": 4.0}],
        ]
        fused = pipeline._rrf_fuse(rankings)
        assert fused[0]["chunk_id"] == "b"  # 两路都命中，融合分最高

    def test_bm25_chinese_tokenize(self):
        """中文分词检索：型号/专有名词可命中。"""
        bm25.rebuild([
            {"chunk_id": "c1", "doc_id": 1, "content": "问：X200 Pro 多少钱\n答：3999 元"},
            {"chunk_id": "c2", "doc_id": 1, "content": "问：运费多少\n答：全国包邮"},
        ])
        hits = bm25.query("X200 Pro 价格")
        assert hits and hits[0]["chunk_id"] == "c1"
