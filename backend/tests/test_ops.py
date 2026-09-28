"""运维能力测试：多模型热备切换 / 监控告警 / 自动备份。"""
import os

from app.agent import engine
from app.core import backup, monitor
from app.schemas import AgentReply


# ============ 多模型热备 ============

async def test_llm_fallback_switch(monkeypatch):
    """主模型硬失败 → 自动切换备用模型。"""
    calls: list[str] = []

    async def fake_once(prompt, *, base_url, api_key, model, conversation_id=0):
        calls.append(model)
        if model == "primary-model":
            return None, True  # 硬失败
        return AgentReply(reply_messages=["备用模型回复"], confidence=0.8), False

    monkeypatch.setattr(engine, "_call_llm_once", fake_once)
    monkeypatch.setattr(engine.settings, "llm_model", "primary-model")
    monkeypatch.setattr(engine.settings, "llm_fallback_model", "backup-model")
    monkeypatch.setattr(engine.settings, "llm_fallback_api_key", "fallback-key")

    reply = await engine._call_llm_with_retry("test prompt")

    assert reply is not None
    assert reply.reply_messages == ["备用模型回复"]
    assert calls == ["primary-model", "backup-model"]


async def test_llm_no_fallback_when_not_configured(monkeypatch):
    """未配置备用模型时，硬失败直接返回 None。"""
    calls: list[str] = []

    async def fake_once(prompt, *, base_url, api_key, model, conversation_id=0):
        calls.append(model)
        return None, True

    monkeypatch.setattr(engine, "_call_llm_once", fake_once)
    monkeypatch.setattr(engine.settings, "llm_model", "primary-model")
    monkeypatch.setattr(engine.settings, "llm_fallback_model", "")
    monkeypatch.setattr(engine.settings, "llm_fallback_api_key", "")

    reply = await engine._call_llm_with_retry("test prompt")

    assert reply is None
    assert calls == ["primary-model"]


async def test_llm_parse_failure_uses_fallback(monkeypatch):
    """解析失败时也切换备用模型，不再直接放弃。"""
    calls: list[str] = []

    async def fake_once(prompt, *, base_url, api_key, model, conversation_id=0):
        calls.append(model)
        if model == "primary-model":
            return None, False
        return AgentReply(reply_messages=["备用模型接上了"], confidence=0.6), False

    monkeypatch.setattr(engine, "_call_llm_once", fake_once)
    monkeypatch.setattr(engine.settings, "llm_model", "primary-model")
    monkeypatch.setattr(engine.settings, "llm_fallback_model", "backup-model")
    monkeypatch.setattr(engine.settings, "llm_fallback_api_key", "fallback-key")

    reply = await engine._call_llm_with_retry("test prompt")

    assert reply is not None
    assert reply.reply_messages == ["备用模型接上了"]
    assert calls == ["primary-model", "backup-model"]


# ============ 监控告警 ============

def test_monitor_record_and_snapshot():
    monitor.record("tool_failure", "测试事件")
    assert monitor.snapshot().get("tool_failure", 0) >= 1


def test_monitor_threshold_alert_without_webhook(monkeypatch):
    """超阈值触发告警逻辑；未配置 webhook 时只记日志不发送（不抛异常即通过）。"""
    monkeypatch.setattr(monitor.settings, "alert_webhook_url", "")
    monkeypatch.setattr(monitor.settings, "alert_cooldown_seconds", 0)
    for _ in range(monitor.THRESHOLDS["webhook_failure"][0]):
        monitor.record("webhook_failure", "压测")
    assert monitor.count_last_hour("webhook_failure") >= monitor.THRESHOLDS["webhook_failure"][0]


# ============ 自动备份 ============

def test_backup_creates_files(tmp_path, monkeypatch):
    monkeypatch.setattr(backup.settings, "backup_dir", str(tmp_path))
    dest = backup.do_backup()
    assert os.path.isdir(dest)
    # 测试库文件应被备份（sqlite backup API）
    assert os.path.exists(os.path.join(dest, "app.db"))


def test_backup_rotation(tmp_path, monkeypatch):
    """滚动清理：超过 keep 数量的旧备份被删除。"""
    monkeypatch.setattr(backup.settings, "backup_dir", str(tmp_path))
    monkeypatch.setattr(backup.settings, "backup_keep", 2)
    for i in range(4):
        # 伪造带时间戳递增的旧备份目录
        fake = tmp_path / f"backup_2024010{i}_000000"
        fake.mkdir()
        (fake / "app.db").write_text("x")
    backup._rotate()
    remaining = [d for d in os.listdir(tmp_path) if d.startswith("backup_")]
    assert len(remaining) == 2
