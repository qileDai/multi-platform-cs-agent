"""RPA 通道适配器：无官方 API 资质时的降级通道（见 docs/rpa-workers.md）。

- 入站：Worker 通过 /api/rpa/incoming 上报接近标准化的 payload，这里只做字段透传
  （platform 保持 douyin/xiaohongshu 不变，工作台/统计/频控无感）
- 出站：不调官方 API，写 rpa_outbox 表，等 Worker 轮询拉取；
  返回占位 ID（rpa_ 前缀），真实发送结果由 Worker ack 回执确认

合规提示：RPA 违反平台用户协议，仅限自有账号、低频拟人化使用。
"""
import logging
import time
import uuid
from typing import Any

from ..schemas import InboundMessage
from .base import PlatformAdapter

logger = logging.getLogger(__name__)


def split_account(platform_conversation_id: str) -> tuple[str, str]:
    """会话 ID 形如 '<account>:<页面会话标识>'，拆出 (account, 页面会话标识)。"""
    if ":" in platform_conversation_id:
        account, conv = platform_conversation_id.split(":", 1)
        return account, conv
    return "", platform_conversation_id


class RpaAdapter(PlatformAdapter):
    """入站用无参实例（platform="rpa"）；出站按平台实例化（RpaAdapter("douyin")），
    使 outbox 记录携带正确平台标识。"""

    def __init__(self, platform: str = "rpa"):
        self.platform = platform

    async def verify_webhook(self, headers: dict[str, str], body: bytes,
                             query: dict[str, str] | None = None) -> bool:
        # RPA 接口走 X-Rpa-Key 鉴权（api/rpa.py 中完成），不经过 webhook 验签
        return True

    async def normalize(self, payload: dict[str, Any]) -> InboundMessage | None:
        msg_type = payload.get("msg_type", "text")
        if msg_type not in ("text", "image", "voice"):
            msg_type = "text"
        account = payload.get("account", "")
        conv_id = payload.get("conversation_id", "")
        # 多账号隔离：会话 ID 统一带 account 前缀
        if account and conv_id and not conv_id.startswith(f"{account}:"):
            conv_id = f"{account}:{conv_id}"
        return InboundMessage(
            platform=payload.get("platform", "douyin"),
            platform_user_id=payload.get("user_id", ""),
            platform_conversation_id=conv_id,
            platform_msg_id=payload.get("msg_id", ""),
            msg_type=msg_type,
            content=payload.get("content", "") or "",
            nickname=payload.get("nickname", ""),
            media_id=payload.get("media_id", ""),
            sender_side=payload.get("sender_side", "user"),
            account=account,
            raw_payload=payload,
        )

    async def send(self, platform_conversation_id: str, platform_user_id: str,
                   content: str, msg_type: str = "text", media_id: str = "") -> str:
        """写 outbox 表（不直接发送），返回占位 ID。Worker 拉取后页面发送并 ack。"""
        from ..database import SessionLocal
        from ..models import RpaOutbox

        account, conv_id = split_account(platform_conversation_id)
        if not account:
            # 会话 ID 无 '<account>:' 前缀（如 mock 面板建的会话切到 RPA 通道）：
            # outbox 记录永远不会有 Worker 来拉取，消息将卡在 pending，必须显式告警
            from ..core import monitor
            logger.warning("[RPA 通道] 会话 %s 缺少 account 前缀，outbox 消息将无 Worker 拉取（死信）",
                           platform_conversation_id)
            monitor.record("rpa_outbox_no_account", f"conv={platform_conversation_id}")
        placeholder = f"rpa_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
        db = SessionLocal()
        try:
            db.add(RpaOutbox(
                account=account,
                platform=self.platform if self.platform != "rpa" else "",
                platform_conversation_id=conv_id,
                platform_user_id=platform_user_id,
                content=content,
                msg_type=msg_type,
                media_id=media_id,
                status="pending",
            ))
            db.commit()
        finally:
            db.close()
        logger.info("[RPA 通道] 消息入 outbox account=%s conv=%s type=%s", account, conv_id, msg_type)
        return placeholder
