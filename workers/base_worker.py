"""RPA Worker 公共框架：心跳 / outbox 拉取发送 / 入站监听上报 / 媒体上下行 / 身份缓存 / 自检。

设计要点：
- Worker 主动拉取（pull），不在本机开端口；与后端全部走 HTTP + X-Rpa-Key
- Playwright persistent context：登录态保存在本地 profile 目录，重启免登录
- 平台差异由 PlatformDriver 子类实现（选择器 + 页面操作），本框架不含平台知识
- 本地 SQLite 做两件事：昵称→稳定 ID 缓存、已上报消息去重（防轮询重复上报）
- 运行时自检：登录过期 / 选择器漂移 → 上报对应状态并暂停主循环（不崩溃死循环）

运行：python douyin_feige_worker.py（配置从 .env.local 读取，见 .env.example）
"""
from __future__ import annotations

import abc
import asyncio
import json
import logging
import os
import random
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx
from playwright.async_api import Page, async_playwright

logger = logging.getLogger("rpa_worker")


# ============ 配置 ============

@dataclass
class WorkerConfig:
    backend_url: str = "http://127.0.0.1:8000"
    rpa_key: str = ""
    worker_id: str = ""
    account: str = ""          # 店铺账号（与后端 outbox 路由一致）
    platform: str = "douyin"   # douyin | xiaohongshu
    headless: bool = True      # 生产建议 headless=new；调试可改 false
    profile_dir: str = "./profiles"
    poll_interval: float = 2.0
    heartbeat_interval: float = 10.0
    state_db: str = "./worker_state.db"
    download_dir: str = "./downloads"
    platform_url: str = ""     # 覆盖平台后台入口地址（留空用 driver 默认；平台改地址时无需改代码）

    @property
    def backend_platform(self) -> str:
        """上报后端的平台标识：企业号 driver 归 douyin 渠道（会话/统计/通道路由一致，
        仅页面目标与频控规则不同）。"""
        return {"douyin_enterprise": "douyin"}.get(self.platform, self.platform)

    @classmethod
    def from_env(cls, env_file: str = ".env.local") -> "WorkerConfig":
        """从 .env.local 读取（简单 KEY=VALUE 解析，不依赖 python-dotenv）。

        编码容错：Windows PowerShell 5.1 的 Set-Content 在中文系统会生成 GBK/ANSI
        文件（旧版 setup 还可能生成 UTF-16），按 utf-8-sig → utf-8 → utf-16 → gb18030
        顺序回退解码；gb18030 可解码几乎任意字节序列，作为最终兜底。
        """
        path = Path(env_file)
        if path.exists():
            text = None
            for enc in ("utf-8-sig", "utf-8", "utf-16", "gb18030"):
                try:
                    text = path.read_text(encoding=enc)
                    break
                except UnicodeDecodeError:
                    continue
            if text is None:
                raise SystemExit(f"无法读取 {env_file}：编码无法识别（支持 UTF-8/UTF-16/GBK），请删除后重新运行 setup")
            for line in text.splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())
        cfg = cls(
            backend_url=os.environ.get("BACKEND_URL", "http://127.0.0.1:8000").rstrip("/"),
            rpa_key=os.environ.get("RPA_API_KEY", ""),
            worker_id=os.environ.get("WORKER_ID", f"worker-{uuid.uuid4().hex[:6]}"),
            account=os.environ.get("ACCOUNT", ""),
            platform=os.environ.get("PLATFORM", "douyin"),
            headless=os.environ.get("HEADLESS", "true").lower() != "false",
            profile_dir=os.environ.get("PROFILE_DIR", "./profiles"),
            poll_interval=float(os.environ.get("POLL_INTERVAL", "2")),
            heartbeat_interval=float(os.environ.get("HEARTBEAT_INTERVAL", "10")),
            state_db=os.environ.get("STATE_DB", "./worker_state.db"),
            download_dir=os.environ.get("DOWNLOAD_DIR", "./downloads"),
            platform_url=os.environ.get("PLATFORM_URL", "").strip(),
        )
        if not cfg.rpa_key:
            raise SystemExit("未配置 RPA_API_KEY（.env.local），请先运行 setup 并填写")
        if not cfg.account:
            raise SystemExit("未配置 ACCOUNT（店铺账号标识，需与后端会话 account 一致）")
        return cfg


# ============ 后端客户端 ============

class BackendClient:
    """与后端 /api/rpa/* 的全部交互。"""

    def __init__(self, cfg: WorkerConfig):
        self.cfg = cfg
        self._client = httpx.AsyncClient(
            base_url=cfg.backend_url,
            headers={"X-Rpa-Key": cfg.rpa_key},
            timeout=30,
        )

    async def close(self):
        await self._client.aclose()

    async def heartbeat(self, status: str, meta: dict | None = None, dry_run: bool = False):
        await self._client.post("/api/rpa/heartbeat", json={
            "worker_id": self.cfg.worker_id, "account": self.cfg.account,
            "platform": self.cfg.backend_platform, "status": status,
            "meta": {**(meta or {}), "driver_platform": self.cfg.platform},
            "dry_run": dry_run,
        })

    async def pull_outbox(self, limit: int = 5) -> list[dict]:
        resp = await self._client.get("/api/rpa/outbox", params={
            "worker_id": self.cfg.worker_id, "account": self.cfg.account, "limit": limit})
        resp.raise_for_status()
        return resp.json().get("messages", [])

    async def ack(self, outbox_id: int, ok: bool, error: str = "", result: str = ""):
        """回执。result：发布类任务回传平台侧结果（如笔记 URL），存 outbox.result。"""
        await self._client.post("/api/rpa/ack", json={
            "outbox_id": outbox_id, "worker_id": self.cfg.worker_id, "ok": ok,
            "error": error[:500], "platform_msg_id": result[:500]})

    async def download_material(self, material_id: int, dest: str) -> str:
        """下载内容素材（materials 表，发布任务用）。"""
        resp = await self._client.get(f"/api/rpa/material/{material_id}")
        resp.raise_for_status()
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(resp.content)
        return dest

    async def report_incoming(self, item: dict) -> str:
        """上报入站消息，返回后端解析出的稳定用户 ID。"""
        resp = await self._client.post("/api/rpa/incoming", json={
            "account": self.cfg.account, "platform": self.cfg.backend_platform, **item})
        resp.raise_for_status()
        return resp.json().get("user_id", "")

    async def report_comment(self, item: dict):
        """上报作品评论（评论采集通道，入队评论引擎）。"""
        resp = await self._client.post("/api/rpa/incoming_comment", json={
            "account": self.cfg.account,
            "platform": {"douyin_enterprise": "douyin"}.get(self.cfg.platform, self.cfg.platform),
            **item})
        resp.raise_for_status()

    async def upload_media(self, data: bytes, filename: str, mime: str, kind: str) -> str:
        resp = await self._client.post(
            "/api/rpa/media", params={"kind": kind},
            files={"file": (filename, data, mime)})
        resp.raise_for_status()
        return resp.json()["media_id"]

    async def download_media(self, media_id: str, dest: str) -> str:
        resp = await self._client.get(f"/api/rpa/media/{media_id}")
        resp.raise_for_status()
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(resp.content)
        return dest

    async def health(self) -> bool:
        try:
            resp = await self._client.get("/api/health")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False


# ============ 本地状态（身份缓存 + 消息去重） ============

class LocalState:
    def __init__(self, db_path: str):
        self._db = sqlite3.connect(db_path)
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS identity_cache (
                nickname TEXT PRIMARY KEY, stable_user_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS seen_messages (
                msg_key TEXT PRIMARY KEY, created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS kv (
                k TEXT PRIMARY KEY, v TEXT NOT NULL);
        """)
        self._db.commit()

    def kv_get(self, key: str, default: str = "") -> str:
        row = self._db.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
        return row[0] if row else default

    def kv_set(self, key: str, value: str):
        self._db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, value))
        self._db.commit()

    def get_identity(self, nickname: str) -> str | None:
        row = self._db.execute(
            "SELECT stable_user_id FROM identity_cache WHERE nickname=?", (nickname,)).fetchone()
        return row[0] if row else None

    def put_identity(self, nickname: str, stable_user_id: str):
        self._db.execute("INSERT OR REPLACE INTO identity_cache VALUES (?,?)",
                         (nickname, stable_user_id))
        self._db.commit()

    def seen(self, msg_key: str) -> bool:
        return self._db.execute(
            "SELECT 1 FROM seen_messages WHERE msg_key=?", (msg_key,)).fetchone() is not None

    def mark_seen(self, msg_key: str):
        import time
        self._db.execute("INSERT OR IGNORE INTO seen_messages VALUES (?,?)",
                         (msg_key, time.time()))
        # 只保留最近 5000 条，防无限膨胀
        self._db.execute("""
            DELETE FROM seen_messages WHERE msg_key NOT IN (
                SELECT msg_key FROM seen_messages ORDER BY created_at DESC LIMIT 5000)
        """)
        self._db.commit()


# ============ 平台驱动抽象 ============

@dataclass
class IncomingItem:
    conv_key: str           # 页面侧会话标识
    msg_key: str            # 消息唯一键（去重用）
    nickname: str
    sender_side: str = "user"   # user | agent（agent = 客服在平台后台直接发的旁路消息）
    msg_type: str = "text"      # text | image | voice
    content: str = ""
    media_url: str = ""         # 页面内媒体地址（框架负责抓字节上传后端）
    prev_nickname: str = ""     # 改昵称识别（可选）


class PlatformDriver(abc.ABC):
    """平台页面操作抽象。选择器集中在子类 SELECTORS，页面改版时单点维护。"""

    name: str = "base"
    url: str = ""

    @abc.abstractmethod
    async def check_status(self, page: Page) -> str:
        """返回 online | login_expired | selector_mismatch。"""
        ...

    @abc.abstractmethod
    async def read_incoming(self, page: Page) -> list[IncomingItem]:
        """扫描页面，返回自上次以来的新消息（框架负责去重）。"""
        ...

    @abc.abstractmethod
    async def send_message(self, page: Page, conv_key: str, content: str,
                           msg_type: str = "text", media_path: str = "") -> None:
        """定位会话并发送。失败抛异常（框架负责重试与 ack failed）。"""
        ...

    async def check_platform_bot_disabled(self, page: Page) -> bool:
        """检查平台自带机器人/自动回复已关闭（防抢答）。默认跳过。"""
        return True


# ============ Worker 主体 ============

class BaseWorker:
    def __init__(self, cfg: WorkerConfig, driver: PlatformDriver,
                 backend: BackendClient | None = None):
        self.cfg = cfg
        self.driver = driver
        self.backend = backend or BackendClient(cfg)
        self.state = LocalState(cfg.state_db)
        self.status = "offline"
        self._paused = False

    @property
    def target_url(self) -> str:
        """平台后台入口：PLATFORM_URL 环境变量优先，否则用 driver 默认地址。"""
        return self.cfg.platform_url or self.driver.url

    async def _goto_with_retry(self, page: Page, url: str, attempts: int = 3):
        """导航容错：网络抖动/代理问题时指数退避重试，仍失败则清晰报错退出。"""
        delay = 2.0
        for i in range(1, attempts + 1):
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning("打开平台后台失败（第 %d/%d 次）: %s", i, attempts, exc)
                if i == attempts:
                    raise SystemExit(
                        f"无法打开平台后台 {url}：{exc}\n"
                        "请检查：1) 本机网络/代理；2) 平台入口地址是否变更"
                        "（可在 .env.local 配置 PLATFORM_URL 覆盖）；3) 平台是否临时不可用") from exc
                await asyncio.sleep(delay)
                delay *= 2

    # ---- 拟人化输入 ----
    @staticmethod
    async def type_humanlike(page: Page, selector: str, text: str):
        delay = random.randint(50, 130)
        await page.locator(selector).first.press_sequentially(text, delay=delay)
        await page.wait_for_timeout(random.randint(200, 500))

    # ---- 状态管理 ----
    async def _set_status(self, status: str):
        if status != self.status:
            logger.warning("Worker 状态变更: %s → %s", self.status, status)
            self.status = status
        self._paused = status != "online"

    async def _self_check(self, page: Page):
        try:
            status = await self.driver.check_status(page)
        except Exception as exc:  # noqa: BLE001
            logger.exception("页面自检异常")
            status = "selector_mismatch"
            logger.error("自检异常详情: %s", exc)
        await self._set_status(status)
        # 运行时在检：平台自带机器人/自动回复开启会与本系统双份回复（只告警不暂停，避免误伤）
        if status == "online":
            try:
                if not await self.driver.check_platform_bot_disabled(page):
                    logger.warning("检测到平台自带机器人/自动回复已开启，可能双份回复，请在平台后台关闭")
            except Exception:  # noqa: BLE001
                logger.exception("平台机器人状态检查失败")

    # ---- 主循环 ----
    async def run(self):
        Path(self.cfg.download_dir).mkdir(parents=True, exist_ok=True)
        async with async_playwright() as pw:
            # Playwright ≥1.49 的 Chromium headless 默认即新版无头模式（规避 Windows 锁屏问题）
            context = await pw.chromium.launch_persistent_context(
                user_data_dir=os.path.join(self.cfg.profile_dir, self.cfg.account),
                headless=self.cfg.headless,
                viewport={"width": 1440, "height": 900},
            )
            page = context.pages[0] if context.pages else await context.new_page()
            await self._goto_with_retry(page, self.target_url)
            await self._self_check(page)
            logger.info("Worker %s 启动（account=%s platform=%s status=%s）",
                        self.cfg.worker_id, self.cfg.account, self.cfg.platform, self.status)
            try:
                await asyncio.gather(
                    self._heartbeat_loop(),
                    self._outbound_loop(page),
                    self._inbound_loop(page),
                )
            finally:
                await context.close()
                await self.backend.close()

    async def _heartbeat_loop(self):
        while True:
            try:
                await self.backend.heartbeat(self.status, meta={
                    "driver": self.driver.name,
                    "paused": self._paused,
                })
            except Exception:  # noqa: BLE001
                logger.exception("心跳失败")
            await asyncio.sleep(self.cfg.heartbeat_interval)

    async def _outbound_loop(self, page: Page):
        while True:
            await asyncio.sleep(self.cfg.poll_interval)
            if self._paused:
                continue
            try:
                messages = await self.backend.pull_outbox()
            except Exception:  # noqa: BLE001
                logger.exception("拉取 outbox 失败")
                continue
            for item in messages:
                await self._send_one(page, item)

    async def _send_one(self, page: Page, item: dict):
        outbox_id = item["outbox_id"]
        media_path = ""
        try:
            # 媒体消息：先从后端下载
            if item.get("media_id"):
                media_path = await self.backend.download_media(
                    item["media_id"],
                    os.path.join(self.cfg.download_dir, item["media_id"]))
            await self.driver.send_message(
                page, item["conversation_id"], item.get("content", ""),
                item.get("msg_type", "text"), media_path)
            await self.backend.ack(outbox_id, True)
            logger.info("发送成功 outbox_id=%s", outbox_id)
        except Exception as exc:  # noqa: BLE001
            logger.exception("发送失败 outbox_id=%s", outbox_id)
            await self.backend.ack(outbox_id, False, error=str(exc))
            # 发送失败可能是页面状态问题，触发一次自检
            await self._self_check(page)

    async def _inbound_loop(self, page: Page):
        while True:
            await asyncio.sleep(self.cfg.poll_interval)
            if self._paused:
                continue
            try:
                items = await self.driver.read_incoming(page)
            except Exception:  # noqa: BLE001
                logger.exception("读取入站消息失败")
                await self._self_check(page)
                continue
            for item in items:
                await self._report_one(item, page)

    async def _report_one(self, item: IncomingItem, page: Page | None = None):
        if self.state.seen(item.msg_key):
            return
        try:
            # 媒体消息：页面内抓取字节 → 上传后端
            media_id = ""
            if item.media_url:
                media_id = await self._fetch_and_upload_media(item, page)
            user_id = await self.backend.report_incoming({
                "nickname": item.nickname,
                "content": item.content,
                "msg_type": item.msg_type,
                "media_id": media_id,
                "msg_id": item.msg_key,
                "conversation_id": item.conv_key,
                "sender_side": item.sender_side,
                "prev_nickname": item.prev_nickname,
            })
            if item.nickname and user_id:
                self.state.put_identity(item.nickname, user_id)
            self.state.mark_seen(item.msg_key)
            logger.info("已上报消息 msg_key=%s type=%s side=%s",
                        item.msg_key, item.msg_type, item.sender_side)
        except Exception:  # noqa: BLE001
            logger.exception("上报失败 msg_key=%s（下轮重试）", item.msg_key)

    async def _fetch_and_upload_media(self, item: IncomingItem, page: Page | None = None) -> str:
        """下载页面内媒体字节并上传后端，返回 media_id。"""
        if item.media_url.startswith("data:"):
            # data: URL 直接解码
            import base64
            header, b64 = item.media_url.split(",", 1)
            mime = header.split(";")[0].removeprefix("data:") or "application/octet-stream"
            data = base64.b64decode(b64)
        else:
            data, mime = await self._download_media_bytes(item.media_url, page)
        kind = "voice" if item.msg_type == "voice" else "image"
        ext = ".png" if "png" in mime else ".jpg" if "image" in mime else ".ogg" if "audio" in mime else ".bin"
        return await self.backend.upload_media(data, f"{item.msg_key}{ext}", mime, kind)

    @staticmethod
    async def _download_media_bytes(url: str, page: Page | None) -> tuple[bytes, str]:
        """抓取媒体字节。优先走浏览器上下文请求（自动带登录 cookie —— 真实平台 CDN
        常有鉴权/签名时效，裸 httpx 直连容易 403），失败再回退 httpx 直连。"""
        if page is not None:
            try:
                resp = await page.context.request.get(url, timeout=30000)
                if resp.ok:
                    mime = resp.headers.get("content-type", "application/octet-stream").split(";")[0]
                    return await resp.body(), mime
                logger.warning("浏览器上下文下载媒体失败（HTTP %s），回退 httpx 直连", resp.status)
            except Exception:  # noqa: BLE001
                logger.warning("浏览器上下文下载媒体异常，回退 httpx 直连: %s", url[:80])
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            mime = resp.headers.get("content-type", "application/octet-stream").split(";")[0]
            return resp.content, mime


# ============ 评论 Worker（评论采集 + 评论回复，供各平台评论 driver 复用） ============

@dataclass
class CommentItem:
    comment_id: str          # 平台评论 ID（幂等键）
    post_url: str = ""       # 作品链接（关联 Post 用）
    post_id: str = ""        # 平台作品 ID（可空）
    author_nickname: str = ""
    author_id: str = ""
    content: str = ""
    parent_comment_id: str = ""


class CommentDriver(PlatformDriver):
    """评论管理页驱动抽象：采集新评论 + 定位评论回复。"""

    @abc.abstractmethod
    async def read_comments(self, page: Page) -> list[CommentItem]:
        """扫描评论管理页，返回新评论（框架负责去重）。"""
        ...

    @abc.abstractmethod
    async def reply_comment(self, page: Page, comment_id: str, text: str,
                            post_url: str = "") -> None:
        """定位评论并回复。失败抛异常（框架负责 ack failed）。"""
        ...

    @abc.abstractmethod
    async def post_first_comment(self, page: Page, post_url: str, text: str) -> None:
        """在作品页发顶层评论（首评引流）。失败抛异常（框架负责 ack failed）。"""
        ...


class CommentWorker(BaseWorker):
    """评论 Worker：入站循环采集评论上报，出站循环处理 comment_reply 回复任务。"""

    driver: CommentDriver

    async def _inbound_loop(self, page: Page):
        while True:
            await asyncio.sleep(self.cfg.poll_interval)
            if self._paused:
                continue
            try:
                items = await self.driver.read_comments(page)
            except Exception:  # noqa: BLE001
                logger.exception("读取评论失败")
                await self._self_check(page)
                continue
            for item in items:
                await self._report_comment(item)

    async def _report_comment(self, item: CommentItem):
        if not item.comment_id or self.state.seen(f"comment_{item.comment_id}"):
            return
        try:
            await self.backend.report_comment({
                "post_url": item.post_url,
                "platform_post_id": item.post_id,
                "comment_id": item.comment_id,
                "parent_comment_id": item.parent_comment_id,
                "author_id": item.author_id,
                "author_nickname": item.author_nickname,
                "content": item.content,
            })
            self.state.mark_seen(f"comment_{item.comment_id}")
            logger.info("已上报评论 comment_id=%s", item.comment_id)
        except Exception:  # noqa: BLE001
            logger.exception("评论上报失败 comment_id=%s（下轮重试）", item.comment_id)

    async def _send_one(self, page: Page, item: dict):
        msg_type = item.get("msg_type")
        if msg_type not in ("comment_reply", "first_comment"):
            return  # 非评论任务不处理
        outbox_id = item["outbox_id"]
        try:
            payload = json.loads(item.get("content") or "{}")
        except json.JSONDecodeError as exc:
            await self.backend.ack(outbox_id, False, error=f"回复任务 JSON 解析失败: {exc}")
            return
        try:
            if msg_type == "first_comment":
                await self.driver.post_first_comment(
                    page, payload.get("post_url", ""), payload.get("text", ""))
                logger.info("首评发布成功 outbox_id=%s", outbox_id)
            else:
                await self.driver.reply_comment(
                    page, payload.get("comment_id", ""), payload.get("text", ""),
                    payload.get("post_url", ""))
                logger.info("评论回复成功 outbox_id=%s comment=%s",
                            outbox_id, payload.get("comment_id"))
            await self.backend.ack(outbox_id, True)
        except Exception as exc:  # noqa: BLE001
            logger.exception("评论任务失败 outbox_id=%s type=%s", outbox_id, msg_type)
            await self.backend.ack(outbox_id, False, error=str(exc))
            await self._self_check(page)


# ============ 入口 ============

def run_worker(cfg: WorkerConfig, driver: PlatformDriver):
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    worker = BaseWorker(cfg, driver)
    try:
        asyncio.run(worker.run())
    except KeyboardInterrupt:
        logger.info("Worker 已停止")


def run_comment_worker(cfg: WorkerConfig, driver: CommentDriver):
    """评论 Worker 入口。"""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    worker = CommentWorker(cfg, driver)
    try:
        asyncio.run(worker.run())
    except KeyboardInterrupt:
        logger.info("Worker 已停止")
