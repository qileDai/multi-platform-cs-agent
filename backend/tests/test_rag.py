"""RAG 管线测试（纯 BM25 降级模式，不依赖外部 API）。"""
import pytest
import pytest_asyncio

from app.models import KnowledgeChunk, KnowledgeDoc, Message, MissedQuestion
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
        text = "段落一内容" * 120 + "\n\n" + "段落二内容" * 120
        sections = ingest.split_sections(text)
        assert len(sections) == 2
        assert "段落一内容" in sections[0].text
        assert "段落二内容" in sections[1].text
        assert "段落二内容" not in sections[0].text

    def test_sentences_without_blank_lines(self):
        text = "标准款售价是九十九元整。购买两件可以享受九折优惠。全国范围内包邮到家。"
        sections = ingest.split_sections(text)
        assert len(sections) == 1
        assert "九十九" in sections[0].text
        assert "九折" in sections[0].text
        assert "包邮" in sections[0].text

    def test_numbered_headings_split(self):
        text = "一、价格说明如下\n标准款售价九十九元整。\n2. 运费说明如下\n全国范围内包邮到家。"
        sections = ingest.split_sections(text)
        assert sections
        assert all(not section.heading.startswith("2.") for section in sections)
        assert any(section.heading.startswith("一、") and "九十九" in section.text and "包邮" in section.text
                   for section in sections)

    def test_heading_stays_with_body(self):
        sections = ingest.split_sections("## 价格说明\n\n标准款 99 元，两件九折。")
        assert len(sections) == 1
        assert sections[0].heading == "## 价格说明"
        assert "99" in sections[0].text

    def test_sliding_window_breaks_on_sentence(self):
        sentence = "这是一句完整的话。"
        text = sentence * 80
        sections = ingest.split_sections(text)
        assert len(sections) == 1
        assert sections[0].text == text
        assert sections[0].text.endswith("。")

    def test_tiny_fragments_dropped(self):
        assert ingest.split_text("嗯。\n\n啊。") == []

    def test_mianqian_list_not_split_by_heading(self):
        text = (
            "（七）开户成功约到面签\n\n"
            "【面签资料清单】：\n"
            "1、董事个人身份证和港澳通行证\n"
            "2、香港公司全套注册资料原件\n"
            "3、公司业务证明和个人地址证明\n"
            "4、开户调查问卷\n\n"
            "面签注意事项：董事股东要清楚经营情况。"
        )
        sections = ingest.split_sections(text)
        list_sections = [section for section in sections if "1、董事个人身份证" in section.text]
        assert len(list_sections) == 1
        blob = list_sections[0].text
        assert "2、香港公司全套注册资料原件" in blob
        assert "3、公司业务证明和个人地址证明" in blob
        assert "4、开户调查问卷" in blob
        assert all(not section.heading.startswith("4、") for section in sections)
        notes = [section for section in sections if "董事股东要清楚经营情况" in section.text]
        assert notes
        assert notes[0].text.index("4、开户调查问卷") < notes[0].text.index("董事股东要清楚经营情况")

    def test_overlap_ratio_between_sentence_sections(self):
        sentence = "这是用来测试重叠的一句话。"
        first = sentence * 20
        second = "下一段从这里开始说明后续安排。"
        sections = ingest.split_sections(first + "\n\n" + second)
        assert len(sections) == 2
        prev = ingest._body_of(sections[0])
        curr = ingest._body_of(sections[1])
        assert curr.endswith(second)
        prefix = curr[: -len(second)].rstrip("\n")
        assert prefix
        assert prev.endswith(prefix)
        ratio = len(prefix) / len(prev)
        assert ingest.OVERLAP_MIN <= ratio <= ingest.OVERLAP_MAX
        assert prefix.endswith("。")


class TestParseFile:
    def test_parse_file_docx_heading_blank_and_number(self):
        import io

        from docx import Document
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn

        doc = Document()
        doc.add_heading("开户前资料确认", level=1)
        doc.add_paragraph("")
        first = doc.add_paragraph("董事个人身份证和港澳通行证")
        second = doc.add_paragraph("香港公司全套注册资料原件")
        for paragraph in (first, second):
            p_pr = paragraph._p.get_or_add_pPr()
            num_pr = OxmlElement("w:numPr")
            level = OxmlElement("w:ilvl")
            level.set(qn("w:val"), "0")
            num_id = OxmlElement("w:numId")
            num_id.set(qn("w:val"), "9")
            num_pr.append(level)
            num_pr.append(num_id)
            p_pr.append(num_pr)
        bullet = doc.add_paragraph("手持证件照片")
        p_pr = bullet._p.get_or_add_pPr()
        num_pr = OxmlElement("w:numPr")
        level = OxmlElement("w:ilvl")
        level.set(qn("w:val"), "0")
        num_id = OxmlElement("w:numId")
        num_id.set(qn("w:val"), "99")
        num_pr.append(level)
        num_pr.append(num_id)
        p_pr.append(num_pr)
        buf = io.BytesIO()
        doc.save(buf)
        text = ingest.parse_file("注册.docx", buf.getvalue())
        assert "## 开户前资料确认" in text
        assert "\n\n" in text
        assert "1、董事个人身份证和港澳通行证" in text
        assert "2、香港公司全套注册资料原件" in text
        assert "· 手持证件照片" in text
        sections = ingest.split_sections(text)
        assert any(section.heading.startswith("##") and "董事个人身份证" in section.text for section in sections)

    def test_parse_file_doc_asks_for_docx(self):
        with pytest.raises(ValueError, match="docx"):
            ingest.parse_file("注册.doc", b"not a real doc")

    def test_pdf_wrapped_list_stays_one_section(self):
        pages = [
            "赢态财务\n1、董事个人身份证和港澳通行\n证原件\n2、香港公司全套注册资料原件\n页脚",
            "赢态财务\n3、公司业务证明和个人地址证明\n4、开户调查问卷\n页脚",
        ]
        text = ingest._unwrap_pdf_text("\n".join(ingest._strip_repeated_page_edges(pages)))
        assert "赢态财务" not in text
        assert "页脚" not in text
        assert "1、董事个人身份证和港澳通行证原件" in text
        sections = ingest.split_sections("（七）面签资料\n\n" + text + "\n\n面签注意事项：董事股东要清楚经营情况。")
        blob = "\n".join(section.text for section in sections if "1、董事个人身份证和港澳通行证原件" in section.text)
        assert "2、香港公司全套注册资料原件" in blob
        assert "3、公司业务证明和个人地址证明" in blob
        assert "4、开户调查问卷" in blob
        assert all(not section.heading.startswith("4、") for section in sections)


class TestPipeline:
    @pytest.mark.asyncio
    async def test_faq_recall_hit(self, faq_doc, db):
        """FAQ 入库后可召回，且整对问答只占一块。"""
        chunks = db.query(KnowledgeChunk).filter(KnowledgeChunk.doc_id == faq_doc.id).all()
        assert len(chunks) == 1
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
async def test_configured_rerank_empty_falls_back(monkeypatch):
    """精排已配置但返回空时，退回向量分差，分差够大仍可生成。"""
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
    assert result.passed is True
    assert result.reason == "passed"
    assert result.rerank_status == "unavailable"
    assert result.rerank_top_score is None
    assert "99" in result.contexts[0]["content"]


@pytest.mark.asyncio
async def test_long_doc_parent_and_heading(db):
    """长话术保持一整块，检索文本带文档标题和小节标题。"""
    sentence = "本商品支持七天无理由退换，运费由商家承担，"
    text = "## 退换政策\n" + sentence * 40 + "特殊口令紫金退换。"
    doc = KnowledgeDoc(title="售后手册", doc_type="file", content=text, status="active")
    db.add(doc)
    db.commit()
    db.refresh(doc)
    try:
        await ingest.ingest_document(doc.id)
        db.expire_all()
        chunks = db.query(KnowledgeChunk).filter(KnowledgeChunk.doc_id == doc.id).all()
        assert len(chunks) == 1
        assert chunks[0].parent_id is None
        assert "退换政策" in chunks[0].content
        assert "【售后手册】" in chunks[0].content
        assert "特殊口令紫金退换" in chunks[0].content
        hits = bm25.query("特殊口令紫金退换")
        assert hits
        result = await pipeline.retrieve("特殊口令紫金退换", history=[])
        assert result.passed is True
        assert "退换政策" in result.contexts[0]["content"]
        assert "【售后手册】" in result.contexts[0]["content"]
        assert "特殊口令紫金退换" in result.contexts[0]["content"]
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
    result = await rewrite.rewrite_query(
        "那这个多少钱", history, summary="用户在看标准款",
    )
    assert prompts
    assert '{"standalone"' in prompts[0]
    assert "看看这个" in prompts[0]
    assert "用户在看标准款" in prompts[0]
    assert result[0] == "这个多少钱"


@pytest.mark.asyncio
async def test_rewrite_runs_on_first_turn(monkeypatch):
    """没有更早对话、也没有指代时不改写。有更早对话才请求改写。"""
    from app.rag import rewrite

    called = []

    class _Completions:
        async def create(self, **kwargs):
            called.append(kwargs)
            assert kwargs["max_tokens"] == 200

            class _Msg:
                content = '{"standalone": "商品价格", "variants": ["多少钱"]}'

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
    monkeypatch.setattr(rewrite, "AsyncOpenAI", lambda **kwargs: _Client())
    skipped = await rewrite.rewrite_query("多少钱", [{"sender_type": "user", "content": "多少钱"}])
    assert skipped == ["多少钱"]
    assert called == []
    history = [
        {"sender_type": "user", "content": "看看这款"},
        {"sender_type": "user", "content": "多少钱"},
    ]
    result = await rewrite.rewrite_query("多少钱", history)
    assert called
    assert result[0] == "商品价格"
    assert "多少钱" in result


def test_rerank_payload_accepts_data_score():
    from app.rag.rerank import parse_rerank_payload

    parsed = parse_rerank_payload({"data": [{"index": 1, "score": 0.2}, {"index": 0, "score": 0.8}]})
    assert parsed[0]["index"] == 0
    assert parsed[0]["score"] == 0.8
    assert parse_rerank_payload({"results": []}) is None


@pytest.mark.asyncio
async def test_below_threshold_trace_on_user_message(db, conversation, monkeypatch):
    """精排分低于阈值时不生成，用户消息上留下原因。"""
    from app.agent import engine

    db.add(Message(conversation_id=conversation.id, sender_type="user",
                   msg_type="text", content="这个多少钱"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(
            passed=False,
            reason="rerank_below_threshold",
            rerank_top_score=0.22,
            rewritten_queries=["这个多少钱"],
            dense_count=2,
            bm25_count=1,
            fused_top=[{"chunk_id": "chunk_1", "content": "价格", "score": 0.22}],
            rerank_status="used",
        )

    async def fake_llm(*_a, **_k):
        from app.schemas import AgentReply
        return AgentReply(reply_messages=["我先让同事确认"], intent="other", confidence=0.2, handoff=True, handoff_reason="low_confidence")

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")

    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    user = (
        db.query(Message)
        .filter(Message.conversation_id == conversation.id, Message.sender_type == "user")
        .one()
    )
    assert user.extra["retrieval"]["reason"] == "rerank_below_threshold"
    assert user.extra["retrieval"]["rerank_top_score"] == 0.22
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "确认" in ai.content


def test_customer_profile_in_prompt(db, conversation):
    from app.agent import context, prompt as prompt_mod
    from app.models import Conversation, Customer

    customer = db.get(Customer, conversation.customer_id)
    customer.tags = ["高意向"]
    customer.lead_phone = "13800000000"
    db.add(Conversation(
        customer_id=customer.id, platform="mock", mode="human", status="closed",
        summary="上次问过标准款价格",
    ))
    db.commit()

    profile = context.customer_profile_text(conversation.id)
    rendered = prompt_mod.render_prompt(
        platform="mock",
        knowledge_context="标准款 99 元",
        history_text="",
        user_message="这个呢",
        customer_profile=profile,
        rewritten_question="标准款多少钱",
    )
    assert "高意向" in rendered
    assert "13800000000" in rendered
    assert "上次问过标准款价格" in rendered
    assert "标准款多少钱" in rendered


@pytest.mark.asyncio
async def test_summary_after_four_messages(db, conversation, monkeypatch):
    from app.agent import context

    for role, content in (
        ("user", "看看这个"),
        ("ai", "在的"),
        ("user", "多少钱"),
        ("ai", "标准款 99"),
    ):
        db.add(Message(conversation_id=conversation.id, sender_type=role, msg_type="text", content=content))
    db.commit()

    class _Msg:
        content = "用户在问标准款价格，已告知 99。"

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    class _Completions:
        async def create(self, **_kwargs):
            return _Resp()

    class _Chat:
        completions = _Completions()

    class _Client:
        chat = _Chat()

    monkeypatch.setattr(context.settings, "llm_api_key", "test-key")
    monkeypatch.setattr(context, "AsyncOpenAI", lambda **_kwargs: _Client())
    await context.maybe_update_summary(conversation.id)
    db.expire_all()
    db.refresh(conversation)
    assert "99" in conversation.summary
    assert conversation.summary_upto_message_id


def test_ungrounded_amount_detector():
    from app.agent.engine import _has_ungrounded_amount

    contexts = [{"content": "标准款 99 元"}]
    assert _has_ungrounded_amount(["这款 199元"], contexts) is True
    assert _has_ungrounded_amount(["这款 99元"], contexts) is False


@pytest.mark.asyncio
async def test_ungrounded_price_blocks_reply(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="多少钱"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(
            passed=True,
            reason="passed",
            contexts=[{"content": "标准款 99 元", "source": "价格", "doc_id": 1}],
            rewritten_queries=["标准款多少钱"],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["这款要 199元"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).one()
    assert "199" not in ai.content
    assert "确认" in ai.content
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")


@pytest.mark.asyncio
async def test_tool_reply_keeps_numbers_outside_knowledge(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply, ToolCall

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="快递到哪了"))
    db.commit()
    prompts = []
    first = AgentReply(
        reply_messages=[], intent="after_sale", confidence=0.9,
        tool_call=ToolCall(name="query_logistics", args={"order_id": "DD9"}),
    )
    final = AgentReply(reply_messages=["预计 3天 到"], intent="after_sale", confidence=0.9)

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(
            passed=True, contexts=[{"content": "标准款 99 元", "source": "价格"}],
            rewritten_queries=["快递到哪了"], reason="passed",
        )

    async def fake_llm(prompt: str, **_kwargs):
        prompts.append(prompt)
        return first if len(prompts) == 1 else final

    async def fake_logistics(self, args, ctx):
        return {"ok": True, "data": {"latest": "预计 3天 到"}, "error": ""}

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    monkeypatch.setattr(engine.tools.QueryLogisticsTool, "run", fake_logistics)
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).all()
    assert any("3天" in m.content for m in ai)
    db.refresh(conversation)
    assert conversation.mode == "ai"


def _patch_dense(monkeypatch, hits):
    async def fake_embed(texts):
        return [[0.1, 0.2] for _ in texts]

    monkeypatch.setattr(pipeline.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(pipeline.vectorstore, "query", lambda vec, top_k=20: hits)
    monkeypatch.setattr(pipeline.bm25, "query", lambda text, top_k=20: [])
    monkeypatch.setattr(pipeline.settings, "rerank_api_key", "")


@pytest.mark.asyncio
async def test_exact_phrase_in_chunk_survives_dense_gap(monkeypatch):
    _patch_dense(monkeypatch, [
        {"chunk_id": "chunk_901", "doc_id": 1, "content": "办理面签资料清单需要身份证", "score": 0.80},
        {"chunk_id": "chunk_902", "doc_id": 2, "content": "运费说明", "score": 0.75},
    ])
    result = await pipeline.retrieve("面签资料清单", history=[])
    assert result.passed is True
    assert result.reason == "passed"
    assert "面签资料清单" in result.contexts[0]["content"]


@pytest.mark.asyncio
async def test_exact_phrase_in_title_survives_dense_gap(db, monkeypatch):
    doc = KnowledgeDoc(title="面签资料清单", doc_type="file", content="请准备证件。", status="active")
    db.add(doc)
    db.commit()
    db.refresh(doc)
    _patch_dense(monkeypatch, [
        {"chunk_id": "chunk_901", "doc_id": doc.id, "content": "请准备证件", "score": 0.80},
        {"chunk_id": "chunk_902", "doc_id": doc.id + 1000, "content": "运费说明", "score": 0.75},
    ])
    result = await pipeline.retrieve("面签资料清单", history=[])
    assert result.passed is True
    assert result.reason == "passed"


@pytest.mark.asyncio
async def test_short_overlap_still_uses_score_gap(monkeypatch):
    _patch_dense(monkeypatch, [
        {"chunk_id": "chunk_901", "doc_id": 1, "content": "多少钱 99 元", "score": 0.80},
        {"chunk_id": "chunk_902", "doc_id": 2, "content": "多少钱运费", "score": 0.75},
    ])
    result = await pipeline.retrieve("多少钱", history=[])
    assert result.passed is False


@pytest.mark.asyncio
async def test_rerank_below_threshold_keeps_exact_phrase_as_miss(monkeypatch):
    async def fake_embed(texts):
        return [[0.1, 0.2] for _ in texts]

    async def fake_rerank(query, documents, top_n=3):
        return [{"index": 0, "score": 0.1}]

    monkeypatch.setattr(pipeline.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(pipeline.vectorstore, "query", lambda vec, top_k=20: [
        {"chunk_id": "chunk_901", "doc_id": 1, "content": "办理面签资料清单需要身份证", "score": 0.90},
        {"chunk_id": "chunk_902", "doc_id": 2, "content": "运费说明", "score": 0.40},
    ])
    monkeypatch.setattr(pipeline.bm25, "query", lambda text, top_k=20: [])
    monkeypatch.setattr(pipeline.rerank, "rerank", fake_rerank)
    monkeypatch.setattr(pipeline.settings, "rerank_api_key", "test-key")

    result = await pipeline.retrieve("面签资料清单", history=[])
    assert result.passed is True
    assert "面签资料清单" in result.contexts[0]["content"]


@pytest.mark.asyncio
async def test_invoice_polarity_blocked(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="能开增值税专用发票吗"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "不支持开发票", "source": "发票", "doc_id": 1}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["可以，支持开发票"], intent="other", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").one()
    assert "支持开发票" not in ai.content
    assert "可以" not in ai.content
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")


@pytest.mark.asyncio
async def test_kb_miss_fallback_handoff_without_new_number(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="你们周末营业吗"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(passed=False, reason="no_hits", rewritten_queries=[query], contexts=[])

    async def fake_llm(*_a, **_k):
        return AgentReply(
            reply_messages=["这块我先让同事确认"], intent="other", confidence=0.3,
            handoff=False,
        )

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").one()
    assert ai.content
    assert not any(ch.isdigit() for ch in ai.content)
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")
    assert db.query(MissedQuestion).filter(MissedQuestion.conversation_id == conversation.id).count() == 1


@pytest.mark.asyncio
async def test_price_hit_does_not_handoff(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="多少钱"))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "标准款 99 元", "source": "价格", "doc_id": 1}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["这款 99 元"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    monkeypatch.setattr(engine.answer_cache, "lookup", _async_none)
    monkeypatch.setattr(engine.answer_cache, "store", _async_none)
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").one()
    assert "99" in ai.content
    db.refresh(conversation)
    assert conversation.mode == "ai"


async def _async_none(*_a, **_k):
    return None


@pytest.mark.asyncio
async def test_semantic_cache_hit_and_invalidation(monkeypatch):
    from app.rag import cache as answer_cache

    answer_cache.clear()

    async def fake_embed(text):
        return [1.0, 0.0] if "价格" in text or "多少钱" in text else [0.0, 1.0]

    monkeypatch.setattr(answer_cache.embeddings, "embed_query", fake_embed)
    await answer_cache.store("标准款多少钱", ["这款 99 元"], [7])
    assert await answer_cache.lookup("这款价格") == ["这款 99 元"]
    assert await answer_cache.lookup("怎么退货") is None
    answer_cache.invalidate_docs([7])
    assert await answer_cache.lookup("这款价格") is None


def test_split_facets_single_question_stays_one_retrieval():
    assert pipeline.split_facets("多少钱") == []
    assert pipeline.split_facets("你好，这个多少钱") == []


def test_split_facets_two_asks():
    assert pipeline.split_facets("多少钱和包邮吗") == ["多少钱", "包邮吗"]
    assert pipeline.split_facets("发货和退换") == ["发货", "退换"]


def test_seven_days_matches_digit_days():
    assert evidence_fold_supported("七天无理由", "7天无理由退换")
    assert not evidence_fold_supported("这款 199元", "标准款 99 元")


def evidence_fold_supported(reply: str, source: str) -> bool:
    from app.agent import evidence
    return not evidence.claims_unsupported([reply], source)


def test_conflict_drops_both_prices():
    from app.agent import evidence
    contexts = [{"content": "标准款 99 元"}, {"content": "活动价 199 元"}]
    kept, dropped = evidence.partition_messages(["这款 99 元"], "标准款 99 元\n活动价 199 元", contexts)
    assert kept == []
    assert dropped == ["这款 99 元"]


def test_handoff_line_can_name_the_gap():
    from app.agent import evidence
    kept, dropped = evidence.partition_messages(
        ["包邮这句我让同事确认哈"], "", [{"content": "标准款 99 元"}],
    )
    assert kept == ["包邮这句我让同事确认哈"]
    assert dropped == []


@pytest.mark.asyncio
async def test_partial_answer_keeps_price_and_hands_off_shipping(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply

    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text",
        content="多少钱和包邮吗",
    ))
    db.commit()
    calls = []

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        calls.append(query)
        if query == "包邮吗":
            return pipeline.RetrievalResult(passed=False, reason="no_hits", rewritten_queries=[query], contexts=[])
        return pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "标准款 99 元", "source": "价格", "doc_id": 1}],
        )

    async def fake_llm(prompt: str, **_k):
        if "已核对事实" in prompt:
            return AgentReply(reply_messages=["包邮这句我让同事确认哈"], intent="other", confidence=0.4, handoff=True, handoff_reason="low_confidence")
        return AgentReply(reply_messages=["这款 99 元", "全国包邮"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    monkeypatch.setattr(engine.answer_cache, "lookup", _async_none)
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    sent = "\n".join(
        row.content for row in db.query(Message).filter(
            Message.conversation_id == conversation.id, Message.sender_type == "ai",
        )
    )
    assert "99" in sent
    assert "全国包邮" not in sent
    assert "同事" in sent
    db.refresh(conversation)
    assert conversation.mode in ("pending", "human")
    assert calls[0] == "多少钱和包邮吗"
    assert "包邮吗" in calls


@pytest.mark.asyncio
async def test_chitchat_miss_fallback_does_not_handoff(db, conversation, monkeypatch):
    from app.agent import engine
    from app.schemas import AgentReply

    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text",
        content="哈哈哈你们回复好快",
    ))
    db.commit()

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(passed=False, reason="no_hits", rewritten_queries=[query], contexts=[])

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["哈哈那是，我一直盯着呢"], intent="chitchat", confidence=0.9, handoff=False)

    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").one()
    assert "哈哈" in ai.content
    assert not any(ch.isdigit() for ch in ai.content)
    db.refresh(conversation)
    assert conversation.mode == "ai"
    assert db.query(MissedQuestion).filter(MissedQuestion.conversation_id == conversation.id).count() == 0


@pytest.mark.asyncio
async def test_cache_hit_rechecks_current_knowledge(db, conversation, monkeypatch):
    from app.agent import engine
    from app.rag import cache as answer_cache
    from app.schemas import AgentReply

    answer_cache.clear()
    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="多少钱"))
    db.commit()

    async def fake_lookup(_query):
        return ["这款 199 元"]

    async def fake_retrieve(query, history=None, top_k=3, summary=""):
        return pipeline.RetrievalResult(
            passed=True, reason="passed", rewritten_queries=[query],
            contexts=[{"content": "标准款 99 元", "source": "价格", "doc_id": 1}],
        )

    async def fake_llm(*_a, **_k):
        return AgentReply(reply_messages=["这款 99 元"], intent="consult_price", confidence=0.9)

    monkeypatch.setattr(engine.answer_cache, "lookup", fake_lookup)
    monkeypatch.setattr(engine.answer_cache, "store", _async_none)
    monkeypatch.setattr(engine.pipeline, "retrieve", fake_retrieve)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    ai = db.query(Message).filter(Message.conversation_id == conversation.id, Message.sender_type == "ai").one()
    assert "199" not in ai.content
    assert "99" in ai.content
    db.refresh(conversation)
    assert conversation.mode == "ai"


@pytest.mark.asyncio
async def test_covering_retrieve_merges_two_faqs(db):
    price = KnowledgeDoc(title="产品价格", doc_type="faq", content="问：多少钱\n答：标准款 99 元。", status="active")
    ship = KnowledgeDoc(title="运费", doc_type="faq", content="问：包邮吗\n答：全国包邮。", status="active")
    db.add_all([price, ship])
    db.commit()
    db.refresh(price)
    db.refresh(ship)
    await ingest.ingest_faq(price.id)
    await ingest.ingest_faq(ship.id)
    from app.agent import engine
    result = await engine._retrieve_covering("多少钱和包邮吗", [], "")
    blob = "\n".join(item["content"] for item in result.contexts)
    assert "99" in blob
    assert "包邮" in blob
    assert result.gaps == []
    price.status = "archived"
    ship.status = "archived"
    db.commit()
    ingest.rebuild_bm25_from_db()


@pytest.mark.asyncio
async def test_exact_faq_beats_stale_cache_and_other_doc(db, conversation, monkeypatch):
    """原问对上 FAQ 时用这 5 条原文。旧的一句缓存和其他文档条目都不发出。"""
    from app.agent import engine
    from app.schemas import AgentReply

    faq = KnowledgeDoc(
        title="香港开户资料", doc_type="faq", status="active",
        content=(
            "问：香港开户资料\n"
            "答：1、香港公司全套注册资料（CR/BR/NNC1 / 公司章程）；\n"
            "2、董事 / 股东个人资料：身份证 + 港澳通行证 / 护照（有效期 6 个月以上）\n"
            "3、公司业务证明：国内公司营业执照（如有）+ 近 3 个月购销合同 / 提单 / 发票 / 银行流水（2-3 套，体现真实经营）；\n"
            "4、董事 / 股东个人银行流水（近 6 个月，无断月，体现个人资金往来）；\n"
            "5、开户调查问卷（我司提供模板，需您如实填写签字）。"
        ),
    )
    other = KnowledgeDoc(
        title="注册", doc_type="file", status="active",
        content="1、另一份材料里的护照复印件\n2、额外的住址证明",
    )
    db.add_all([faq, other])
    db.commit()
    db.refresh(faq)
    db.refresh(other)
    await ingest.ingest_faq(faq.id)
    await ingest.ingest_document(other.id)
    db.add(Message(
        conversation_id=conversation.id, sender_type="user", msg_type="text",
        content="香港开户资料",
    ))
    db.commit()

    async def fake_lookup(_query):
        return ["香港开户需要准备董事身份证、港澳通行证或护照原件等资料。"]

    async def fake_llm(*_a, **_k):
        return AgentReply(
            reply_messages=["香港开户需要准备董事身份证、港澳通行证或护照原件等资料。"],
            intent="consult_feature", confidence=0.9,
        )

    monkeypatch.setattr(engine.answer_cache, "lookup", fake_lookup)
    monkeypatch.setattr(engine, "_call_llm_with_retry", fake_llm)
    monkeypatch.setattr(engine.settings, "llm_api_key", "test-key")
    await engine.process_ai_reply(conversation.id)
    db.expire_all()
    rows = db.query(Message).filter(
        Message.conversation_id == conversation.id, Message.sender_type == "ai",
    ).all()
    assert len(rows) == 1
    sent = rows[0].content
    for item in ("公司章程", "港澳通行证", "营业执照", "个人银行流水", "开户调查问卷"):
        assert item in sent
    assert "香港开户需要准备董事身份证" not in sent
    assert "另一份材料里的护照复印件" not in sent
    faq.status = "archived"
    other.status = "archived"
    db.commit()
    ingest.rebuild_bm25_from_db()


def test_agent_correction_stays_pending(db, conversation):
    from app.services import note_agent_correction

    db.add(Message(conversation_id=conversation.id, sender_type="user", msg_type="text", content="能周末发货吗"))
    db.commit()
    note_agent_correction(conversation.id, "周末可以发货")
    missed = db.query(MissedQuestion).filter(MissedQuestion.question == "能周末发货吗").one()
    assert missed.status == "pending"
    assert missed.suggested_answer == "周末可以发货"
