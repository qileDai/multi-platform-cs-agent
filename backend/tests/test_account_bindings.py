"""账号授权绑定、出站分队列、外部作品登记、开关落库。"""
import uuid
from datetime import datetime

import pytest

from app import models
from app.config import settings
from app.core.runtime_settings import load_persisted


def _agent(db, role="admin"):
    from app.api.deps import get_current_agent, require_admin
    from app.core.security import hash_password
    from app.main import app

    agent = models.Agent(
        username=f"b_{uuid.uuid4().hex[:8]}", display_name="测试",
        role=role, status="offline", password_hash=hash_password("x"),
    )
    db.add(agent)
    db.commit()
    app.dependency_overrides[get_current_agent] = lambda: agent
    if role == "admin":
        app.dependency_overrides[require_admin] = lambda: agent
    return agent


def _clear(db, agent):
    from app.main import app
    app.dependency_overrides.clear()
    db.rollback()


def _account(db, name="店A", rpa="shop-a", platform="xiaohongshu"):
    account = models.MatrixAccount(
        platform=platform, account_name=name, auth_type="rpa",
        open_id=f"pending_{uuid.uuid4().hex[:8]}", rpa_account=rpa, status="active",
    )
    db.add(account)
    db.commit()
    return account


def test_binding_conflict_and_assignment(db, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(settings, "rpa_api_key", "bind-key")
    agent = _agent(db)
    account = _account(db)
    client = TestClient(app)
    try:
        created = client.post("/api/account-bindings", json={
            "account_id": account.id, "duty": "dm", "driver": "xhs_ark",
            "provider": "adspower", "adspower_profile_id": "profile-1",
            "worker_id": "worker-1",
        })
        assert created.status_code == 200, created.text
        clash = client.post("/api/account-bindings", json={
            "account_id": account.id, "duty": "comment", "driver": "xhs_comment",
            "provider": "adspower", "adspower_profile_id": "profile-1",
            "worker_id": "worker-2",
        })
        assert clash.status_code == 409

        headers = {"X-Rpa-Key": "bind-key"}
        assigned = client.get("/api/rpa/assignment", params={"worker_id": "worker-1"}, headers=headers)
        assert assigned.status_code == 200
        body = assigned.json()
        assert body["bound"] is True
        assert body["driver"] == "xhs_ark"
        assert body["account"] == "shop-a"
        assert body["msg_types"] == ["text", "image", "voice"]

        heart = client.post("/api/rpa/heartbeat", headers=headers, json={
            "worker_id": "worker-1", "account": "shop-a", "platform": "xiaohongshu",
            "status": "online", "meta": {"binding_id": created.json()["id"]},
        })
        assert heart.status_code == 200
        db.expire_all()
        row = db.get(models.AccountBinding, created.json()["id"])
        assert row.auth_status == "authorized"
    finally:
        _clear(db, agent)


def test_from_profile_names_the_logged_in_account(db, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(settings, "rpa_api_key", "bind-key")
    agent = _agent(db)
    db.add(models.RpaWorker(
        worker_id="worker-auto", account="", platform="idle", status="idle",
        last_heartbeat_at=datetime.utcnow(),
    ))
    db.commit()
    client = TestClient(app)
    try:
        created = client.post("/api/account-bindings/from-profile", json={
            "platform": "xiaohongshu", "duty": "dm",
            "adspower_profile_id": "p9", "profile_name": "环境甲",
        })
        assert created.status_code == 200, created.text
        assert created.json()["worker_id"] == "worker-auto"
        assert created.json()["rpa_account"] == "ads-p9"
        named = client.post("/api/rpa/identity/self", headers={"X-Rpa-Key": "bind-key"}, json={
            "worker_id": "worker-auto", "profile_id": "p9", "account_name": "小红书主号",
        })
        assert named.status_code == 200, named.text
        db.expire_all()
        account = db.query(models.MatrixAccount).filter_by(rpa_account="ads-p9").one()
        assert account.account_name == "小红书主号"
    finally:
        _clear(db, agent)


def test_outbox_msg_types_and_release(db, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(settings, "rpa_api_key", "bind-key")
    client = TestClient(app)
    for msg_type, content in (("text", "你好"), ("comment_reply", "{}")):
        db.add(models.RpaOutbox(
            account="shop-a", platform="xiaohongshu", content=content, msg_type=msg_type,
        ))
    db.commit()
    headers = {"X-Rpa-Key": "bind-key"}
    pulled = client.get("/api/rpa/outbox", params={
        "worker_id": "worker-c", "account": "shop-a", "msg_types": "comment_reply",
    }, headers=headers)
    assert pulled.status_code == 200
    messages = pulled.json()["messages"]
    assert len(messages) == 1
    assert messages[0]["msg_type"] == "comment_reply"
    released = client.post("/api/rpa/release", headers=headers, json={
        "outbox_id": messages[0]["outbox_id"], "worker_id": "worker-c",
    })
    assert released.status_code == 200
    db.expire_all()
    row = db.get(models.RpaOutbox, messages[0]["outbox_id"])
    assert row.status == "pending"
    assert row.attempts == 0
    still = db.query(models.RpaOutbox).filter_by(account="shop-a", msg_type="text").one()
    assert still.status == "pending"


def test_switch_persists(db):
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_agent, require_admin
    from app.main import app

    agent = _agent(db)
    client = TestClient(app)
    original = settings.comment_auto_reply_enabled
    try:
        resp = client.put("/api/settings/auto-switches", json={"comment_auto_reply_enabled": True})
        assert resp.status_code == 200
        settings.comment_auto_reply_enabled = False
        load_persisted(db)
        assert settings.comment_auto_reply_enabled is True
    finally:
        client.put("/api/settings/auto-switches", json={"comment_auto_reply_enabled": original})
        app.dependency_overrides.pop(get_current_agent, None)
        app.dependency_overrides.pop(require_admin, None)


@pytest.mark.asyncio
async def test_external_comment_registers_post(db, monkeypatch):
    monkeypatch.setattr(settings, "comment_auto_reply_enabled", False)
    account = _account(db, rpa=f"ext-{uuid.uuid4().hex[:6]}")
    from app.comments.engine import handle_inbound_comment

    url = f"https://www.xiaohongshu.com/explore/{uuid.uuid4().hex[:8]}"
    await handle_inbound_comment({
        "platform": "xiaohongshu",
        "platform_comment_id": f"c-{uuid.uuid4().hex[:8]}",
        "account": account.rpa_account,
        "post_url": url,
        "content": "多少钱",
    })
    db.expire_all()
    post = db.query(models.Post).filter(models.Post.url == url).one()
    task = db.get(models.PublishTask, post.publish_task_id)
    assert task.status == "external"
    listed = db.query(models.ContentItem).filter(models.ContentItem.topic == "外部登记").count()
    assert listed >= 1


@pytest.mark.asyncio
async def test_comment_reply_uses_knowledge_and_survives_retrieve_failure(monkeypatch):
    from app.comments.engine import _generate_reply
    from app.rag.pipeline import RetrievalResult

    async def hit(_content, top_k=2, **kwargs):
        return RetrievalResult(passed=True, contexts=[{"content": "标准款 99 元"}])

    seen = {}

    async def fake_llm(prompt, contract):
        seen["prompt"] = prompt
        return contract(reply="私信我发你价格")

    monkeypatch.setattr("app.rag.pipeline.retrieve", hit)
    monkeypatch.setattr("app.comments.engine.call_llm_json", fake_llm)
    assert await _generate_reply("多少钱", "price") == "私信我发你价格"
    assert "99 元" in seen["prompt"]

    async def boom(*_args, **_kwargs):
        raise RuntimeError("检索不可用")

    monkeypatch.setattr("app.rag.pipeline.retrieve", boom)

    async def short(_prompt, contract):
        return contract(reply="私信我")

    monkeypatch.setattr("app.comments.engine.call_llm_json", short)
    assert await _generate_reply("在吗", "consult") == "私信我"
