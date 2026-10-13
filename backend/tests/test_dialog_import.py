"""历史对话 xlsx 导入为停用 FAQ，待补不入库。"""
import io
import uuid
import zipfile

from fastapi.testclient import TestClient

from app.api.deps import get_current_agent
from app.core.security import hash_password
from app.main import app
from app.models import Agent, KnowledgeChunk, KnowledgeDoc


def _sheet_xml() -> str:
    price = (
        "顾客 2026-09-10 10:00:00 怎么收费&#xA;"
        "刘小姐 2026-09-10 10:00:05 现在是我们10周年庆典3980的活动价(含3900的官费)，"
        "包含秘书服务，秘书地址，绿盒子全套"
    )
    interest = (
        "顾客 2026-09-10 11:00:00 我要注册香港公司&#xA;"
        "刘小姐 2026-09-10 11:00:05 您留个联系方式"
    )

    def row(n, valid, missed, content):
        return (
            f'<row r="{n}">'
            f'<c r="A{n}" t="str"><v>c{n}</v></c>'
            f'<c r="C{n}" t="str"><v>{valid}</v></c>'
            f'<c r="D{n}" t="str"><v>{missed}</v></c>'
            f'<c r="V{n}" t="str"><v>注册</v></c>'
            f'<c r="Y{n}" t="str"><v>香港林</v></c>'
            f'<c r="BS{n}" t="str"><v>2026-09-10 10:00:00</v></c>'
            f'<c r="CK{n}" t="str"><v>{content}</v></c>'
            f"</row>"
        )

    rows = [
        '<row r="1"><c r="A1" t="str"><v>对话ID</v></c></row>',
        row(2, "有效", "未遗漏", price),
        row(3, "有效", "未遗漏", interest),
        row(4, "有效", "遗漏", price),
        row(5, "无效", "未遗漏", price),
    ]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(rows)}</sheetData></worksheet>"
    )


def _xlsx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/worksheets/sheet1.xml", _sheet_xml())
    return buf.getvalue()


def test_import_dialogs_creates_disabled_faq_and_skips_gap(db):
    agent = Agent(
        username=f"import_{uuid.uuid4().hex[:8]}", display_name="导入", role="agent",
        status="offline", password_hash=hash_password("x"),
    )
    db.add(agent)
    db.commit()
    app.dependency_overrides[get_current_agent] = lambda: agent
    client = TestClient(app)
    titles = ("香港公司注册费用", "想注册香港公司")
    try:
        resp = client.post(
            "/api/knowledge/import-dialogs",
            files={"file": ("历史对话.xlsx", _xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["created"] == 1
        assert body["imported"] == 1
        assert body["skipped_missed"] == 1
        assert body["skipped_invalid"] == 1
        assert "想注册香港公司" in body["gap_titles"]

        doc = db.query(KnowledgeDoc).filter(KnowledgeDoc.title == "香港公司注册费用").one()
        assert doc.status == "disabled"
        assert doc.doc_type == "faq"
        assert doc.content.startswith("问：")
        assert "3980" in doc.content
        assert db.query(KnowledgeChunk).filter(KnowledgeChunk.doc_id == doc.id).count() == 0
        assert db.query(KnowledgeDoc).filter(KnowledgeDoc.title == "想注册香港公司").count() == 0

        again = client.post(
            "/api/knowledge/import-dialogs",
            files={"file": ("历史对话.xlsx", _xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
        assert again.status_code == 200, again.text
        assert again.json()["created"] == 0
        assert again.json()["updated"] == 1
        db.expire_all()
        docs = db.query(KnowledgeDoc).filter(KnowledgeDoc.title == "香港公司注册费用").all()
        assert len(docs) == 1
        assert docs[0].status == "disabled"
        assert docs[0].version == 2

        rejected = client.post(
            "/api/knowledge/import-dialogs",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )
        assert rejected.status_code == 400
    finally:
        app.dependency_overrides.pop(get_current_agent, None)
        db.query(KnowledgeDoc).filter(KnowledgeDoc.title.in_(titles)).delete(synchronize_session=False)
        db.query(Agent).filter(Agent.id == agent.id).delete(synchronize_session=False)
        db.commit()
