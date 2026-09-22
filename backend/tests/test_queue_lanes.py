"""Phase 8 队列加固：双通道隔离 / 指数退避重试 / 最终失败全局告警。"""
import asyncio
from datetime import datetime, timedelta

import pytest

from app import models
from app.core import monitor, queue


def _clean_queue(db):
    db.query(models.QueueTask).delete()
    db.commit()


class TestLaneFetch:
    def test_lane_separation(self, db):
        """fast/slow 各自只取本通道任务；不传 lane 兼容旧行为（按 id 顺序）。"""
        _clean_queue(db)
        fast_id = queue.enqueue("inbound_message", {"x": 1})
        slow_id = queue.enqueue("content_generate", {"x": 2})
        try:
            assert queue._fetch_next_pending("fast") == fast_id
            assert queue._fetch_next_pending("slow") == slow_id
            assert queue._fetch_next_pending() == fast_id  # 兼容旧调用
        finally:
            _clean_queue(db)

    def test_lane_of(self):
        assert queue._lane_of("inbound_message") == "fast"
        assert queue._lane_of("inbound_comment") == "fast"
        assert queue._lane_of("content_generate") == "slow"
        assert queue._lane_of("first_comment") == "slow"


class TestDualLane:
    @pytest.mark.asyncio
    async def test_fast_not_blocked_by_slow(self, db, monkeypatch):
        """慢任务处理中（processing），fast 通道任务仍可被消费。"""
        _clean_queue(db)
        # 通道按 task_type 划分：把测试类型注入 fast 集合（不污染真实 inbound_* 处理器）
        monkeypatch.setattr(queue, "FAST_LANE_TYPES",
                            queue.FAST_LANE_TYPES | {"fast_test_ping"})
        started = asyncio.Event()
        release = asyncio.Event()
        done_fast = asyncio.Event()

        async def slow_handler(payload):
            started.set()
            await release.wait()

        async def fast_handler(payload):
            done_fast.set()

        queue.register_handler("slow_test_block", slow_handler)
        queue.register_handler("fast_test_ping", fast_handler)
        queue.start_worker()
        try:
            queue.enqueue("slow_test_block", {})
            await asyncio.wait_for(started.wait(), 5)  # 确认慢任务已进入处理中
            queue.enqueue("fast_test_ping", {})
            await asyncio.wait_for(done_fast.wait(), 5)  # slow 仍阻塞，fast 已完成
        finally:
            release.set()
            await queue.stop_worker()
            _clean_queue(db)


class TestRetryBackoff:
    @pytest.mark.asyncio
    async def test_retry_with_backoff(self, db):
        """首次失败：retries+1、重回 pending、not_before 推到未来（退避）。"""
        _clean_queue(db)
        attempted = asyncio.Event()

        async def fail_handler(payload):
            attempted.set()
            raise RuntimeError("瞬时故障")

        queue.register_handler("fail_backoff_test", fail_handler)
        queue.start_worker()
        tid = queue.enqueue("fail_backoff_test", {})
        try:
            await asyncio.wait_for(attempted.wait(), 5)
            # 等失败写回
            deadline = datetime.utcnow() + timedelta(seconds=5)
            task = None
            while datetime.utcnow() < deadline:
                db.expire_all()
                task = db.get(models.QueueTask, tid)
                if task.retries >= 1:
                    break
                await asyncio.sleep(0.05)
            assert task is not None and task.retries == 1
            assert task.status == "pending"
            # 退避：第 1 次重试延迟 ~30s（留 5s 余量防计时抖动）
            assert task.not_before is not None
            assert task.not_before > datetime.utcnow() + timedelta(seconds=20)
        finally:
            await queue.stop_worker()
            _clean_queue(db)

    @pytest.mark.asyncio
    async def test_final_failure_recorded(self, db, monkeypatch):
        """重试用尽（MAX_RETRIES=0 模拟一次即终败）：failed + queue_task_failed 告警。"""
        _clean_queue(db)
        records = []
        monkeypatch.setattr(monitor, "record", lambda e, d="": records.append((e, d)))
        monkeypatch.setattr(queue, "MAX_RETRIES", 0)

        async def fail_handler(payload):
            raise RuntimeError("永久故障")

        queue.register_handler("fail_final_test", fail_handler)
        tid = queue.enqueue("fail_final_test", {})
        try:
            await queue._process_one(tid)
            db.expire_all()
            task = db.get(models.QueueTask, tid)
            assert task.status == "failed"
            assert "永久故障" in (task.error or "")
            assert any(e == "queue_task_failed" for e, _ in records)
        finally:
            _clean_queue(db)

    @pytest.mark.asyncio
    async def test_inbound_message_keeps_webhook_failure_channel(self, db, monkeypatch):
        """inbound_message 最终失败时除 queue_task_failed 外，保留既有 webhook_failure 埋点。"""
        _clean_queue(db)
        records = []
        monkeypatch.setattr(monitor, "record", lambda e, d="": records.append((e, d)))
        monkeypatch.setattr(queue, "MAX_RETRIES", 0)

        async def fail_handler(payload):
            raise RuntimeError("入站处理故障")

        original = queue._HANDLERS.get("inbound_message")
        queue.register_handler("inbound_message", fail_handler)
        tid = queue.enqueue("inbound_message", {"channel": "mock"})
        try:
            await queue._process_one(tid)
            events = [e for e, _ in records]
            assert "queue_task_failed" in events
            assert "webhook_failure" in events
        finally:
            if original is not None:
                queue.register_handler("inbound_message", original)
            else:
                queue._HANDLERS.pop("inbound_message", None)
            _clean_queue(db)

    @pytest.mark.asyncio
    async def test_success_marks_done(self, db):
        """正常路径：处理成功置 done。"""
        _clean_queue(db)

        async def ok_handler(payload):
            pass

        queue.register_handler("ok_test", ok_handler)
        tid = queue.enqueue("ok_test", {})
        try:
            await queue._process_one(tid)
            db.expire_all()
            assert db.get(models.QueueTask, tid).status == "done"
        finally:
            _clean_queue(db)


# ============ 失败任务运维 API ============

class TestQueueOpsApi:
    def _make_failed(self, db) -> models.QueueTask:
        task = models.QueueTask(task_type="content_generate", payload={"x": 1},
                                status="failed", retries=3, error="LLM 超时",
                                not_before=datetime.utcnow())
        db.add(task)
        db.commit()
        db.refresh(task)
        return task

    def _admin_token(self, db) -> str:
        import uuid as _uuid
        from app.core.security import create_access_token, hash_password
        agent = models.Agent(username=f"ops_{_uuid.uuid4().hex[:6]}",
                             password_hash=hash_password("x"), display_name="管理员",
                             role="admin", status="resting")
        db.add(agent)
        db.commit()
        return create_access_token(agent.id, agent.username)

    def test_failed_list_requires_auth(self, db):
        from fastapi.testclient import TestClient
        from app.main import app
        _clean_queue(db)
        client = TestClient(app)
        assert client.get("/api/queue/failed").status_code == 401

    def test_failed_list_and_counts(self, db):
        from fastapi.testclient import TestClient
        from app.main import app
        _clean_queue(db)
        task = self._make_failed(db)
        token = self._admin_token(db)
        client = TestClient(app)
        resp = client.get("/api/queue/failed", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["failed"] == 1 and data["pending"] == 0
        row = next(r for r in data["items"] if r["id"] == task.id)
        assert row["task_type"] == "content_generate"
        assert row["error"] == "LLM 超时"
        assert row["retries"] == 3
        _clean_queue(db)

    def test_retry_resets_to_pending(self, db):
        from fastapi.testclient import TestClient
        from app.main import app
        _clean_queue(db)
        task = self._make_failed(db)
        token = self._admin_token(db)
        client = TestClient(app)
        resp = client.post(f"/api/queue/{task.id}/retry",
                           headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        db.expire_all()
        task = db.get(models.QueueTask, task.id)
        assert task.status == "pending"
        assert task.retries == 0
        assert task.not_before is None
        assert task.error == ""
        _clean_queue(db)

    def test_retry_non_failed_400(self, db):
        from fastapi.testclient import TestClient
        from app.main import app
        _clean_queue(db)
        task = models.QueueTask(task_type="content_generate", payload={}, status="done")
        db.add(task)
        db.commit()
        token = self._admin_token(db)
        client = TestClient(app)
        resp = client.post(f"/api/queue/{task.id}/retry",
                           headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 400
        assert client.post("/api/queue/999999/retry",
                           headers={"Authorization": f"Bearer {token}"}).status_code == 404
        _clean_queue(db)
