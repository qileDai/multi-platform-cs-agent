"""抖音飞鸽客服后台 Worker：Chrome CDP/Playwright 自动化。

目标页面：飞鸽客服后台（抖音电商商家官方客服工作台）。

选择器说明（重要）：
- 选择器集中在 SELECTORS，页面改版时只需改这里 + workers/fixtures/fake_feige.html
- 当前选择器与伪平台 fixture 页面契约一致（可端到端测试）；
  对接真实飞鸽后台时，请按实际 DOM 调整，并用 doctor.py 验证

运行：python douyin_feige_worker.py（配置见 .env.example / .env.local）
"""
import hashlib
import logging

from playwright.async_api import Page

from base_worker import (BaseWorker, IncomingItem, PlatformDriver, WorkerConfig,
                         run_worker)

logger = logging.getLogger("rpa_worker.douyin")

# 飞鸽后台地址（商家客服工作台网页版官方入口；平台改地址时可用 PLATFORM_URL 覆盖，无需改代码）
FEIGE_URL = "https://im.jinritemai.com/pc_seller_v2/main/workspace"

# ============ 选择器（与 fixtures/fake_feige.html 契约一致；真实页面需按实际 DOM 调整） ============
SELECTORS = {
    "login_form": ".login-form",                    # 出现即登录过期
    "conversation_list": ".conversation-list",      # 会话列表容器（缺失即选择器漂移）
    "conversation_item": ".conversation-item",      # 单个会话（data-conv 属性为会话标识）
    "unread_badge": ".unread-badge",                # 未读红点
    "nickname": ".conv-nickname",                   # 会话上的用户昵称
    "message_item": ".message-item",                # 消息气泡（data-mid 唯一，data-side=user|self）
    "message_text": ".message-text",                # 文本内容节点
    "message_image": "img.message-image",           # 图片消息
    "message_audio": "audio.message-audio",         # 语音消息
    "chat_input": ".chat-input",                    # 输入框
    "send_button": ".send-button",                  # 发送按钮
    "file_input": "input[type='file']",             # 附件上传 input
    "bot_enabled_flag": ".platform-bot-enabled",    # 平台自带机器人开启标记（存在即未关闭）
    "self_name": ".self-account-name",              # 当前登录的店铺/账号名（真实页面需校准）
}

# 每轮额外扫描会话列表顶部 N 个会话（不依赖未读红点），用于捕捉人工客服在平台后台
# 直接发送的旁路消息；靠 msg_key 去重，不会重复上报
SCAN_RECENT = 3


class FeigeDriver(PlatformDriver):
    name = "douyin_feige"
    url = FEIGE_URL

    async def check_status(self, page: Page) -> str:
        # 登录表单常驻 DOM、通过显隐切换，必须按「可见性」判断（count 会把隐藏元素也算进去）
        if await page.locator(SELECTORS["login_form"]).first.is_visible():
            return "login_expired"
        if await page.locator(SELECTORS["conversation_list"]).count() == 0:
            return "selector_mismatch"
        return "online"

    async def check_platform_bot_disabled(self, page: Page) -> bool:
        """飞鸽自带智能客服机器人开启时页面会有对应标记（fixture 契约）。"""
        return await page.locator(SELECTORS["bot_enabled_flag"]).count() == 0

    async def read_incoming(self, page: Page) -> list[IncomingItem]:
        """扫描有未读红点的会话 + 列表顶部最近活跃会话，提取新消息（含我方旁路消息）。

        旁路场景：人工客服在平台后台直接回复时，该会话通常没有未读红点
        （未读针对的是用户消息），只扫未读会漏掉旁路同步；
        因此每轮额外扫描顶部 SCAN_RECENT 个会话，靠 msg_key 去重保证不重复上报。
        """
        items: list[IncomingItem] = []
        convs = page.locator(SELECTORS["conversation_item"])
        for i in range(await convs.count()):
            conv = convs.nth(i)
            conv_key = await conv.get_attribute("data-conv") or ""
            if not conv_key:
                continue
            has_unread = await conv.locator(SELECTORS["unread_badge"]).count() > 0
            if not has_unread and i >= SCAN_RECENT:
                continue
            nickname = await conv.locator(SELECTORS["nickname"]).inner_text()
            await conv.click()
            await page.wait_for_timeout(300)
            items.extend(await self._read_messages(page, conv_key, nickname.strip()))
        return items

    async def _read_messages(self, page: Page, conv_key: str, nickname: str) -> list[IncomingItem]:
        items: list[IncomingItem] = []
        bubbles = page.locator(SELECTORS["message_item"])
        for j in range(await bubbles.count()):
            bubble = bubbles.nth(j)
            side = await bubble.get_attribute("data-side") or "user"
            sender_side = "agent" if side == "self" else "user"

            # 消息类型：图片 / 语音 / 文本
            img = bubble.locator(SELECTORS["message_image"])
            audio = bubble.locator(SELECTORS["message_audio"])
            text_node = bubble.locator(SELECTORS["message_text"])
            msg_type, content, media_url = "text", "", ""
            if await img.count() > 0:
                msg_type = "image"
                media_url = await img.first.get_attribute("src") or ""
            elif await audio.count() > 0:
                msg_type = "voice"
                media_url = await audio.first.get_attribute("src") or ""
            elif await text_node.count() > 0:
                content = (await text_node.first.inner_text()).strip()
            else:
                continue

            msg_key = await bubble.get_attribute("data-mid") or ""
            if not msg_key:
                # 无稳定消息 ID 时用确定性哈希兜底（随机 uuid 会导致每轮轮询重复上报）；
                # 代价：同一会话内内容完全相同的重复消息只会上报一次
                fingerprint = f"{conv_key}|{side}|{msg_type}|{content or media_url}"
                msg_key = f"{conv_key}_{hashlib.md5(fingerprint.encode()).hexdigest()[:12]}"

            items.append(IncomingItem(
                conv_key=conv_key, msg_key=msg_key, nickname=nickname,
                sender_side=sender_side, msg_type=msg_type,
                content=content, media_url=media_url))
        return items

    async def send_message(self, page: Page, conv_key: str, content: str,
                           msg_type: str = "text", media_path: str = "") -> None:
        # 定位会话
        conv = page.locator(f"{SELECTORS['conversation_item']}[data-conv='{conv_key}']")
        if await conv.count() == 0:
            raise RuntimeError(f"会话不存在: {conv_key}")
        await conv.first.click()
        await page.wait_for_timeout(300)

        # 媒体先发附件，再发文本（如有）
        if msg_type in ("image", "voice") and media_path:
            file_input = page.locator(SELECTORS["file_input"])
            if await file_input.count() == 0:
                raise RuntimeError("页面无附件上传入口（选择器漂移或平台不支持）")
            await file_input.first.set_input_files(media_path)
            await page.wait_for_timeout(800)  # 等待附件上传完成

        if content:
            await BaseWorker.type_humanlike(page, SELECTORS["chat_input"], content)

        # 发送确认：发送前计数我方气泡，发送后等待数量 +1
        # （直接等 selector 会在已有历史我方气泡时立即命中，无法确认本次发送）
        self_bubbles = f"{SELECTORS['message_item']}[data-side='self']"
        before = await page.locator(self_bubbles).count()
        await page.locator(SELECTORS["send_button"]).first.click()
        for _ in range(25):  # 200ms × 25 = 5s 超时
            await page.wait_for_timeout(200)
            if await page.locator(self_bubbles).count() > before:
                return
        raise RuntimeError("发送后未出现新的我方气泡，发送可能失败")


if __name__ == "__main__":
    run_worker(WorkerConfig.from_env(), FeigeDriver())
