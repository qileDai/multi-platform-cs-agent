"""打开执行用的浏览器页面。

local：Playwright 自己的持久化目录，供测试和未装 AdsPower 的机器。
adspower：指纹浏览器负责隔离，Playwright 只通过 CDP 操作已经打开的窗口。
"""
from __future__ import annotations

import logging
import os
import random

import httpx
from playwright.async_api import Page

logger = logging.getLogger("rpa_worker")


class BrowserSession:
    def __init__(self, page: Page, closer):
        self.page = page
        self._closer = closer

    async def close(self):
        await self._closer()


class AdsPowerError(RuntimeError):
    pass


class AdsPowerClient:
    def __init__(self, base_url: str, api_key: str = ""):
        self.base_url = (base_url or "http://127.0.0.1:50325").rstrip("/")
        self.headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    async def start(self, profile_id: str, *, headless: bool = False) -> str:
        if not profile_id:
            raise AdsPowerError("未配置 AdsPower 环境 ID")
        payload = {
            "profile_id": profile_id,
            "last_opened_tabs": "0",
            "proxy_detection": "0",
            "headless": "1" if headless else "0",
        }
        data = await self._request("POST", "/api/v2/browser-profile/start", json=payload)
        ws = ((data.get("data") or {}).get("ws") or {}).get("puppeteer") or ""
        if not ws:
            raise AdsPowerError("AdsPower 未返回 CDP 地址")
        return ws

    async def stop(self, profile_id: str):
        if not profile_id:
            return
        try:
            await self._request("POST", "/api/v2/browser-profile/stop", json={"profile_id": profile_id})
        except Exception:  # noqa: BLE001
            logger.warning("关闭 AdsPower 环境失败 profile=%s", profile_id, exc_info=True)

    async def list_profiles(self, limit: int = 100) -> list[dict]:
        """本机环境列表，只保留 id 和名称。接口失败时抛出，由心跳忽略。"""
        data = await self._request(
            "GET", "/api/v1/user/list", params={"page": 1, "page_size": min(limit, 100)},
        )
        items = ((data.get("data") or {}).get("list") or [])
        profiles = []
        for item in items:
            profile_id = str(item.get("user_id") or item.get("profile_id") or "")
            if not profile_id:
                continue
            profiles.append({
                "id": profile_id,
                "name": str(item.get("name") or item.get("remark") or profile_id),
            })
            if len(profiles) >= limit:
                break
        return profiles

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        async with httpx.AsyncClient(base_url=self.base_url, headers=self.headers, timeout=60) as client:
            resp = await client.request(method, path, **kwargs)
            resp.raise_for_status()
            data = resp.json()
        if data.get("code") not in (0, "0"):
            raise AdsPowerError(str(data.get("msg") or "AdsPower 接口失败"))
        return data


async def open_session(pw, cfg) -> BrowserSession:
    """按配置打开页面。AdsPower 多进程同时启动时先错开几秒。"""
    if (cfg.browser_provider or "local") == "adspower":
        await _stagger()
        client = AdsPowerClient(cfg.adspower_api_base, cfg.adspower_api_key)
        ws = await client.start(cfg.adspower_profile_id, headless=cfg.headless)
        browser = await pw.chromium.connect_over_cdp(ws)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        async def closer():
            try:
                await browser.close()
            except Exception:  # noqa: BLE001
                logger.warning("断开 CDP 失败", exc_info=True)
            await client.stop(cfg.adspower_profile_id)

        return BrowserSession(page, closer)

    context = await pw.chromium.launch_persistent_context(
        user_data_dir=os.path.join(cfg.profile_dir, cfg.account or "default"),
        headless=cfg.headless,
        viewport={"width": 1440, "height": 900},
    )
    page = context.pages[0] if context.pages else await context.new_page()

    async def closer():
        await context.close()

    return BrowserSession(page, closer)


async def _stagger():
    await __import__("asyncio").sleep(random.uniform(0, 3))
