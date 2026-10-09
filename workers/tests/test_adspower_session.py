"""AdsPower 客户端只解析本地接口，不真的打开浏览器。"""
import pytest

from base_worker import WorkerConfig
from browser_session import AdsPowerClient, AdsPowerError


class _Resp:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class _Client:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, method, path, **kwargs):
        self.last = (method, path, kwargs)
        return _Resp({
            "code": 0,
            "data": {"ws": {"puppeteer": "ws://127.0.0.1:9/devtools/browser/abc"}},
        })


@pytest.mark.asyncio
async def test_start_returns_cdp(monkeypatch):
    monkeypatch.setattr("browser_session.httpx.AsyncClient", _Client)
    ws = await AdsPowerClient("http://127.0.0.1:50325", "secret").start("profile-1")
    assert ws.endswith("/abc")


@pytest.mark.asyncio
async def test_start_rejects_error_code(monkeypatch):
    class Bad(_Client):
        async def request(self, method, path, **kwargs):
            return _Resp({"code": -1, "msg": "环境不存在"})

    monkeypatch.setattr("browser_session.httpx.AsyncClient", Bad)
    with pytest.raises(AdsPowerError):
        await AdsPowerClient("http://127.0.0.1:50325").start("missing")


def test_worker_id_is_stable_and_does_not_collide(tmp_path, monkeypatch):
    from base_worker import allocate_worker_id

    monkeypatch.delenv("WORKER_ID", raising=False)
    monkeypatch.setattr("base_worker._pid_alive", lambda pid: pid == 4242)
    (tmp_path / ".worker_id").write_text("worker-keep", encoding="utf-8")
    (tmp_path / ".worker_id.lock").write_text("4242", encoding="utf-8")
    fresh = allocate_worker_id(tmp_path)
    assert fresh != "worker-keep"
    assert fresh.startswith("worker-")
    assert (tmp_path / ".worker_id.2").read_text(encoding="utf-8").strip() == fresh

    monkeypatch.setattr("base_worker._pid_alive", lambda _pid: False)
    again = allocate_worker_id(tmp_path)
    assert again == "worker-keep"


def test_comment_platform_maps_to_api_name():
    cfg = WorkerConfig(rpa_key="x", account="shop", platform="xiaohongshu_comment")
    assert cfg.backend_platform == "xiaohongshu"
    cfg.platform = "douyin_enterprise_comment"
    assert cfg.backend_platform == "douyin"
