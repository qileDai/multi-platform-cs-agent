"""RAG 管线测试（纯 BM25 降级模式，不依赖外部 API）。"""
import pytest
import pytest_asyncio

from app.models import KnowledgeChunk, KnowledgeDoc
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

    def test_blank_lines_keep_long_sections(self):
        text = "段落一。" * 200 + "\n\n" + "段落二。" * 200
        sections = ingest.split_sections(text)
        assert len(sections) == 2
        windows = ingest._sliding_window(sections[0].text)
        assert len(windows) >= 2
        assert all(len(window) <= ingest.CHUNK_SIZE for window in windows)

    def test_heading_stays_with_body(self):
        sections = ingest.split_sections("## 价格说明\n\n标准款 99 元，两件九折。")
        assert len(sections) == 1
        assert sections[0].heading == "## 价格说明"
        assert "99" in sections[0].text

    def test_sliding_window_breaks_on_sentence(self):
        text = "这是一句完整的话。" * 80
        windows = ingest._sliding_window(text)
        assert len(windows) >= 2
        assert all(len(window) <= ingest.CHUNK_SIZE for window in windows)
        assert all(window.endswith("。") for window in windows)

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

    def test_relative_score_drops_weak_second(self):
        """第二条明显更低时不进入上下文。"""
        hits = [
            {"chunk_id": "a", "content": "价格 99", "score": 0.9},
            {"chunk_id": "b", "content": "运费 10", "score": 0.4},
        ]
        kept = pipeline._filter_reranked(hits)
        assert [hit["chunk_id"] for hit in kept] == ["a"]

    def test_degraded_keeps_only_clear_winner(self):
        """纯 BM25：弱相关的另一篇资料不跟着通过；分数接近则整次未命中。"""
        clear = [
            {"chunk_id": "a", "doc_id": 1, "content": "价格", "score": 3.0},
            {"chunk_id": "b", "doc_id": 2, "content": "运费", "score": 1.0},
        ]
        assert [hit["chunk_id"] for hit in pipeline._select_degraded(clear)] == ["a"]
        close = [
            {"chunk_id": "a", "doc_id": 1, "content": "价格", "score": 2.0},
            {"chunk_id": "b", "doc_id": 2, "content": "运费", "score": 1.8},
        ]
        assert pipeline._select_degraded(close) == []

    def test_same_doc_windows_do_not_veto(self):
        """同一文档的重叠子块分数接近时，仍保留第一名。"""
        hits = [
            {"chunk_id": "a", "doc_id": 1, "content": "前半", "score": 2.2},
            {"chunk_id": "b", "doc_id": 1, "content": "后半", "score": 2.0},
        ]
        assert [hit["chunk_id"] for hit in pipeline._select_degraded(hits)] == ["a"]

    def test_degraded_sorts_by_bm25_not_mixed_score(self):
        """融合后的 score 可能是别的路的分，降级比较必须用各文档最高 BM25。"""
        hits = [
            {"chunk_id": "b", "doc_id": 2, "content": "运费", "score": 9.0, "bm25_score": 1.0},
            {"chunk_id": "a", "doc_id": 1, "content": "价格", "score": 0.2, "bm25_score": 3.0},
        ]
        assert [hit["chunk_id"] for hit in pipeline._select_degraded(hits)] == ["a"]

    def test_dense_gap_without_rerank(self):
        """未配精排时只看余弦差，不和 BM25 混在一起比。"""
        clear = [
            {"chunk_id": "a", "doc_id": 1, "dense_score": 0.86, "bm25_score": 1.0},
            {"chunk_id": "b", "doc_id": 2, "dense_score": 0.70, "bm25_score": 8.0},
        ]
        assert [hit["chunk_id"] for hit in pipeline._select_dense_gap(clear)] == ["a"]
        close = [
            {"chunk_id": "a", "doc_id": 1, "dense_score": 0.80},
            {"chunk_id": "b", "doc_id": 2, "dense_score": 0.75},
        ]
        assert pipeline._select_dense_gap(close) == []

    def test_rrf_does_not_mix_dense_and_bm25(self):
        rankings = [
            [{"chunk_id": "a", "doc_id": 1, "content": "x", "score": 0.4, "score_kind": "dense"}],
            [{"chunk_id": "a", "doc_id": 1, "content": "x", "score": 6.0, "score_kind": "bm25"}],
        ]
        fused = pipeline._rrf_fuse(rankings)
        assert fused[0]["dense_score"] == 0.4
        assert fused[0]["bm25_score"] == 6.0
        assert fused[0].get("score") is None

    def test_dedupe_same_parent(self):
        contexts = [
            {"content": "a", "parent_id": 7, "doc_id": 1, "doc_type": "file", "chunk_id": "c1"},
            {"content": "b", "parent_id": 7, "doc_id": 1, "doc_type": "file", "chunk_id": "c2"},
        ]
        assert len(pipeline._dedupe_contexts(contexts)) == 1


@pytest.mark.asyncio
async def test_low_relative_score_not_in_context(monkeypatch):
    """精排后第二条分数明显更低，不会进入生成上下文。"""
    async def fake_embed(texts):
        return [[0.1, 0.2] for _ in texts]

    def fake_dense(vec, top_k=20):
        return [
            {"chunk_id": "chunk_901", "doc_id": 1, "content": "价格 99 元", "score": 0.8},
            {"chunk_id": "chunk_902", "doc_id": 2, "content": "运费 10 元", "score": 0.7},
        ]

    async def fake_rerank(query, documents, top_n=3):
        return [{"index": 0, "score": 0.9}, {"index": 1, "score": 0.4}]

    monkeypatch.setattr(pipeline.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(pipeline.vectorstore, "query", fake_dense)
    monkeypatch.setattr(pipeline.rerank, "rerank", fake_rerank)
    monkeypatch.setattr(pipeline.bm25, "query", lambda text, top_k=20: [])
    monkeypatch.setattr(pipeline.settings, "rerank_api_key", "test-key")

    result = await pipeline.retrieve("多少钱", history=[])
    assert result.passed is True
    assert len(result.contexts) == 1
    assert "99" in result.contexts[0]["content"]
    assert "运费" not in result.contexts[0]["content"]


@pytest.mark.asyncio
async def test_unconfigured_rerank_uses_dense_gap(monkeypatch):
    """只配了向量、没配精排时，分差够大不算未命中。"""
    async def fake_embed(texts):
        return [[0.1, 0.2] for _ in texts]

    def fake_dense(vec, top_k=20):
        return [
            {"chunk_id": "chunk_901", "doc_id": 1, "content": "价格 99 元", "score": 0.86},
            {"chunk_id": "chunk_902", "doc_id": 2, "content": "运费 10 元", "score": 0.70},
        ]

    monkeypatch.setattr(pipeline.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(pipeline.vectorstore, "query", fake_dense)
    monkeypatch.setattr(pipeline.bm25, "query", lambda text, top_k=20: [])
    monkeypatch.setattr(pipeline.settings, "rerank_api_key", "")

    result = await pipeline.retrieve("多少钱", history=[])
    assert result.degraded is False
    assert result.passed is True
    assert len(result.contexts) == 1
    assert "99" in result.contexts[0]["content"]


@pytest.mark.asyncio
async def test_unconfigured_rerank_close_dense_is_miss(monkeypatch):
    async def fake_embed(texts):
        return [[0.1, 0.2] for _ in texts]

    def fake_dense(vec, top_k=20):
        return [
            {"chunk_id": "chunk_901", "doc_id": 1, "content": "价格 99 元", "score": 0.80},
            {"chunk_id": "chunk_902", "doc_id": 2, "content": "运费 10 元", "score": 0.75},
        ]

    monkeypatch.setattr(pipeline.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(pipeline.vectorstore, "query", fake_dense)
    monkeypatch.setattr(pipeline.bm25, "query", lambda text, top_k=20: [])
    monkeypatch.setattr(pipeline.settings, "rerank_api_key", "")

    result = await pipeline.retrieve("多少钱", history=[])
    assert result.passed is False


@pytest.mark.asyncio
async def test_configured_rerank_failure_is_miss(monkeypatch):
    """精排已配置但接口失败时，不用向量分差放行。"""
    async def fake_embed(texts):
        return [[0.1, 0.2] for _ in texts]

    def fake_dense(vec, top_k=20):
        return [
            {"chunk_id": "chunk_901", "doc_id": 1, "content": "价格 99 元", "score": 0.90},
            {"chunk_id": "chunk_902", "doc_id": 2, "content": "运费 10 元", "score": 0.40},
        ]

    async def fake_rerank(query, documents, top_n=3):
        return None

    monkeypatch.setattr(pipeline.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(pipeline.vectorstore, "query", fake_dense)
    monkeypatch.setattr(pipeline.bm25, "query", lambda text, top_k=20: [])
    monkeypatch.setattr(pipeline.rerank, "rerank", fake_rerank)
    monkeypatch.setattr(pipeline.settings, "rerank_api_key", "test-key")

    result = await pipeline.retrieve("多少钱", history=[])
    assert result.passed is False
    assert result.rerank_top_score == 0.0


@pytest.mark.asyncio
async def test_long_doc_parent_and_heading(db):
    """超长小节生成父块，子块检索文本带文档标题和小节标题。"""
    sentence = "本商品支持七天无理由退换，运费由商家承担。"
    text = "## 退换政策\n" + sentence * 40 + "特殊口令紫金退换。"
    doc = KnowledgeDoc(title="售后手册", doc_type="file", content=text, status="active")
    db.add(doc)
    db.commit()
    db.refresh(doc)
    try:
        await ingest.ingest_document(doc.id)
        db.expire_all()
        chunks = db.query(KnowledgeChunk).filter(KnowledgeChunk.doc_id == doc.id).all()
        parents = [c for c in chunks if any(other.parent_id == c.id for other in chunks)]
        children = [c for c in chunks if c.parent_id]
        assert parents
        assert len(parents[0].content) > pipeline.PARENT_CONTEXT_MAX
        assert children
        assert all("退换政策" in c.content and "【售后手册】" in c.content for c in children)
        parent_keys = {f"chunk_{c.id}" for c in parents}
        hits = bm25.query("特殊口令紫金退换")
        assert hits
        assert all(hit["chunk_id"] not in parent_keys for hit in hits)
        result = await pipeline.retrieve("特殊口令紫金退换", history=[])
        assert result.passed is True
        assert "退换政策" in result.contexts[0]["content"]
        assert "【售后手册】" in result.contexts[0]["content"]
        assert len(result.contexts[0]["content"]) < len(parents[0].content)
    finally:
        doc.status = "archived"
        db.commit()
        ingest.rebuild_bm25_from_db()


@pytest.mark.asyncio
async def test_degraded_query_drops_other_doc(db):
    """纯 BM25 下，另一篇弱相关资料不会和第一名一起通过。"""
    price = KnowledgeDoc(
        title="产品价格", doc_type="faq",
        content="问：X200 Pro 多少钱\n答：3999 元。", status="active",
    )
    ship = KnowledgeDoc(
        title="发货时效", doc_type="faq",
        content="问：发货要多久\n答：48 小时内发出。", status="active",
    )
    db.add_all([price, ship])
    db.commit()
    db.refresh(price)
    db.refresh(ship)
    try:
        await ingest.ingest_faq(price.id)
        await ingest.ingest_faq(ship.id)
        result = await pipeline.retrieve("X200 Pro 多少钱", history=[])
        assert result.passed is True
        assert result.degraded is True
        assert len(result.contexts) == 1
        assert "3999" in result.contexts[0]["content"]
    finally:
        price.status = "archived"
        ship.status = "archived"
        db.commit()
        ingest.rebuild_bm25_from_db()


@pytest.mark.asyncio
async def test_rewrite_prompt_survives_json_braces(monkeypatch):
    """改写提示词里的 JSON 花括号不能再把 str.format 打崩。"""
    from app.rag import rewrite

    prompts: list[str] = []

    class _Completions:
        async def create(self, **kwargs):
            prompts.append(kwargs["messages"][0]["content"])

            class _Msg:
                content = '{"standalone": "这个多少钱", "variants": ["价格"]}'

            class _Choice:
                message = _Msg()

            class _Resp:
                choices = [_Choice()]

            return _Resp()

    class _Chat:
        completions = _Completions()

    class _Client:
        chat = _Chat()

    monkeypatch.setattr(rewrite.settings, "llm_api_key", "test-key")
    monkeypatch.setattr(rewrite, "AsyncOpenAI", lambda **_kwargs: _Client())

    history = [
        {"sender_type": "user", "content": "看看这个"},
        {"sender_type": "ai", "content": "在的"},
        {"sender_type": "user", "content": "那这个多少钱"},
    ]
    result = await rewrite.rewrite_query("那这个多少钱", history)
    assert prompts
    assert '{"standalone"' in prompts[0]
    assert "看看这个" in prompts[0]
    assert result[0] == "这个多少钱"


@pytest.mark.asyncio
async def test_rewrite_skips_when_history_is_only_current(monkeypatch):
    from app.rag import rewrite

    monkeypatch.setattr(rewrite.settings, "llm_api_key", "test-key")

    def boom(**_kwargs):
        raise AssertionError("只有当前这句时不应改写")

    monkeypatch.setattr(rewrite, "AsyncOpenAI", boom)
    history = [{"sender_type": "user", "content": "多少钱"}]
    assert await rewrite.rewrite_query("多少钱", history) == ["多少钱"]
