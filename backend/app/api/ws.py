"""WebSocket 管理：工作台实时推送新消息/会话变更。"""
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..core.security import decode_access_token

logger = logging.getLogger(__name__)

router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)
        logger.info("WebSocket 客户端接入，当前 %d 个", len(self.active))

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, event: str, data: dict[str, Any]):
        """广播事件给所有工作台客户端。断开的连接自动清理。"""
        message = json.dumps({"event": event, "data": data}, ensure_ascii=False, default=str)
        dead = []
        for ws in self.active:
            try:
                await ws.send_text(message)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


def broadcast_sync(event: str, data: dict[str, Any]):
    """供同步上下文（队列 worker 外的 DB 操作后）安全广播。"""
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(manager.broadcast(event, data))
    except RuntimeError:
        pass


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = ""):
    """工作台实时通道。广播含私信明文，必须鉴权。

    浏览器 WebSocket 握手无法带 Authorization 头，JWT 走 ?token= 查询参数
    （与 /api/media/{id} 同一方案；生产环境务必 HTTPS，避免 token 进访问日志明文）。
    """
    if not token or decode_access_token(token) is None:
        await websocket.close(code=4401)
        return
    await manager.connect(websocket)
    try:
        while True:
            # 保持连接，客户端心跳/消息目前不处理业务
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
