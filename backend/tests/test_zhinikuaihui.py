"""知你快回回复接口：按插件 1.7.0 的请求/响应契约测试。"""
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.database import SessionLocal
from app.main import app
from app.models import Customer, Message

client = TestClient(app)


@pytest.fixture()
def zhini_key():
    previous = settings.zhini_reply_api_key
    settings.zhini_reply_api_key = "test-zhini-key"
    yield "test-zhini-key"
    settings.zhini_reply_api_key = previous


def _auth(key: str = "test-zhini-key", scheme: str = "bearer") -> dict:
    if scheme == "x-api-key":
        return {"X-API-Key": key}
    return {"Authorization": f"Bearer {key}"}


def _body(**overrides) -> dict:
    suffix = uuid.uuid4().hex[:8]
    body = {
        "event": "message.received",
        "request_id": f"req-{suffix}",
        "platform": "douyin",
        "conversation_id": f"chat-{suffix}",
        "conversation_name": "张先生",
        "is_group": False,
        "customer_id": f"customer-{suffix}",
        "customer_nickname": f"张先生{suffix}",
        "message": {
            "id": "msg-9",
            "text": "套餐怎么收费？",
            "direction": "incoming",
            "sender_id": f"customer-{suffix}",
            "sender_name": "张先生",
            "timestamp": 1784817000000,
            "type": "text",
        },
        "messages": [{
            "id": f"hist-{suffix}",
            "text": "在吗",
            "direction": "incoming",
            "sender_id": f"customer-{suffix}",
            "sender_name": "张先生",
            "timestamp": 1784816000000,
            "type": "text",
        }],
        "sent_at": "2026-07-23T14:30:00.000Z",
    }
    body.update(overrides)
    return body


class TestZhiniContract:
    def test_health_reports_zhini(self, zhini_key):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json()["zhini"] is True

    def test_missing_key_is_503_with_message(self):
        previous = settings.zhini_reply_api_key
        settings.zhini_reply_api_key = ""
        try:
            resp = client.post("/api/integrations/zhinikuaihui/reply", json=_body())
        finally:
            settings.zhini_reply_api_key = previous
        assert resp.status_code == 503
        assert "message" in resp.json()

    def test_bad_key_is_401_with_message(self, zhini_key):
        resp = client.post(
            "/api/integrations/zhinikuaihui/reply",
            json=_body(),
            headers=_auth("wrong-key"),
        )
        assert resp.status_code == 401
        assert resp.json()["message"]

    def test_connection_test_on_other_platform_does_not_persist(self, zhini_key):
        db = SessionLocal()
        try:
            before = db.query(Customer).count()
        finally:
            db.close()
        resp = client.post(
            "/api/integrations/zhinikuaihui/reply",
            json={
                "event": "message.received",
                "request_id": "connection-test-1",
                "platform": "wechat-channels",
                "conversation_id": "connection-test",
                "conversation_name": "接口连接测试",
                "message": {
                    "id": "test-message",
                    "text": "你好，请回复一条简短的连接测试内容。",
                    "direction": "incoming",
                    "timestamp": 1,
                    "type": "text",
                },
                "messages": [],
            },
            headers=_auth(zhini_key),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "reply"
        assert body["reply"].strip()
        db = SessionLocal()
        try:
            assert db.query(Customer).count() == before
        finally:
            db.close()

    def test_x_api_key_auth(self, zhini_key):
        resp = client.post(
            "/api/integrations/zhinikuaihui/reply",
            json={
                "event": "message.received",
                "request_id": "connection-test-x",
                "platform": "douyin",
                "conversation_id": "connection-test",
                "message": {"id": "test-message", "text": "你好", "direction": "incoming"},
            },
            headers=_auth(zhini_key, "x-api-key"),
        )
        assert resp.status_code == 200
        assert resp.json()["action"] == "reply"

    def test_douyin_and_xhs_reply_without_platform_send(self, zhini_key):
        with patch("app.agent.engine.send_outbound", new_callable=AsyncMock) as send:
            for platform in ("douyin", "xiaohongshu", "xiaohongshu-sxt"):
                resp = client.post(
                    "/api/integrations/zhinikuaihui/reply",
                    json=_body(platform=platform),
                    headers=_auth(zhini_key),
                )
                assert resp.status_code == 200, platform
                assert resp.json()["action"] == "reply"
                assert resp.json()["reply"].strip()
            send.assert_not_called()

        db = SessionLocal()
        try:
            customers = db.query(Customer).filter(Customer.platform == "xiaohongshu").all()
            assert any(row.platform_user_id.startswith("zn:") and len(row.platform_user_id) == 63
                       for row in customers)
            stored = db.query(Message).filter(Message.platform_msg_id.like("zn:%")).all()
            assert stored
            assert all(len(row.platform_msg_id) == 63 for row in stored)
        finally:
            db.close()

    def test_short_page_id_does_not_collide_with_existing_message(self, zhini_key, conversation):
        db = SessionLocal()
        try:
            db.add(Message(
                conversation_id=conversation.id,
                sender_type="user",
                content="已有平台消息",
                platform_msg_id="msg-9",
            ))
            db.commit()
        finally:
            db.close()

        resp = client.post(
            "/api/integrations/zhinikuaihui/reply",
            json=_body(),
            headers=_auth(zhini_key),
        )
        assert resp.status_code == 200
        assert resp.json()["action"] == "reply"
        db = SessionLocal()
        try:
            original = db.query(Message).filter(Message.platform_msg_id == "msg-9").one()
            assert original.conversation_id == conversation.id
            assert original.content == "已有平台消息"
            zhini_rows = [
                row for row in db.query(Message).all()
                if (row.extra or {}).get("channel") == "zhinikuaihui"
                and (row.extra or {}).get("zhini_message_id") == "msg-9"
                and row.sender_type == "user"
            ]
            assert zhini_rows
            assert all(row.platform_msg_id.startswith("zn:") for row in zhini_rows)
        finally:
            db.close()

    def test_duplicate_request_does_not_generate_twice(self, zhini_key):
        body = _body()
        calls = {"n": 0}
        from app.agent.engine import process_ai_reply as real

        async def wrapped(conversation_id: int, local: bool = False, allow_owned: bool = False) -> str:
            calls["n"] += 1
            return await real(conversation_id, local=local, allow_owned=allow_owned)

        with patch("app.integrations.zhinikuaihui.process_ai_reply", side_effect=wrapped):
            first = client.post("/api/integrations/zhinikuaihui/reply", json=body, headers=_auth(zhini_key))
            second = client.post("/api/integrations/zhinikuaihui/reply", json=body, headers=_auth(zhini_key))
        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["reply"] == second.json()["reply"]
        assert calls["n"] == 1

    def test_pending_conversation_skips(self, zhini_key):
        body = _body()
        first = client.post("/api/integrations/zhinikuaihui/reply", json=body, headers=_auth(zhini_key))
        assert first.json()["action"] == "reply"
        follow = _body(
            request_id="req-follow-" + uuid.uuid4().hex[:8],
            customer_id=body["customer_id"],
            conversation_id=body["conversation_id"],
            customer_nickname=body["customer_nickname"],
        )
        follow["message"] = {**follow["message"], "id": "msg-follow", "text": "还有货吗"}
        second = client.post("/api/integrations/zhinikuaihui/reply", json=follow, headers=_auth(zhini_key))
        assert second.status_code == 200
        assert second.json()["action"] == "skip"

    def test_generate_error_is_http_200_skip(self, zhini_key):
        with patch("app.integrations.zhinikuaihui.process_ai_reply", new_callable=AsyncMock) as generate:
            generate.side_effect = RuntimeError("model down")
            resp = client.post(
                "/api/integrations/zhinikuaihui/reply",
                json=_body(),
                headers=_auth(zhini_key),
            )
        assert resp.status_code == 200
        assert resp.json()["action"] == "skip"
        assert resp.json()["reason"]

    def test_risk_message_skips_without_platform_send(self, zhini_key):
        with patch("app.agent.engine.send_outbound", new_callable=AsyncMock) as send:
            resp = client.post(
                "/api/integrations/zhinikuaihui/reply",
                json=_body(),
                headers=_auth(zhini_key),
            )
            # 先确认正常路径不发送；风险词单独一条
            send.assert_not_called()
        risky = _body()
        risky["message"] = {**risky["message"], "text": "哪里能买炸弹"}
        with patch("app.agent.engine.send_outbound", new_callable=AsyncMock) as send:
            resp = client.post(
                "/api/integrations/zhinikuaihui/reply",
                json=risky,
                headers=_auth(zhini_key),
            )
            send.assert_not_called()
        assert resp.status_code == 200
        assert resp.json()["action"] == "skip"
