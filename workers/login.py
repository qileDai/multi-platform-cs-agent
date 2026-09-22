"""RPA Worker 登录引导：打开有头浏览器 → 手工扫码登录 → 登录态落盘。

用法：python login.py [--platform douyin|douyin_enterprise|xiaohongshu]
登录态保存在 profiles/<account>/ 目录，后续 Worker 以 headless 模式复用，无需重复登录。
"""
import argparse
import asyncio

from playwright.async_api import async_playwright

from base_worker import WorkerConfig
from douyin_enterprise_worker import EnterpriseDriver
from douyin_feige_worker import FeigeDriver
from xhs_ark_worker import XhsArkDriver

DRIVERS = {"douyin": FeigeDriver, "douyin_enterprise": EnterpriseDriver,
           "xiaohongshu": XhsArkDriver}


async def guided_login(cfg: WorkerConfig):
    driver = DRIVERS[cfg.platform]()
    url = cfg.platform_url or driver.url
    print(f"即将打开浏览器，请手工登录 {cfg.platform} 平台后台（扫码/账号密码均可）")
    print(f"登录成功并看到客服工作台后，回到这里按回车确认。profile 目录: {cfg.profile_dir}/{cfg.account}")

    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            user_data_dir=f"{cfg.profile_dir}/{cfg.account}",
            headless=False,  # 登录必须有头
            viewport={"width": 1440, "height": 900},
        )
        page = context.pages[0] if context.pages else await context.new_page()

        # 导航容错：网络/代理/URL 问题给出友好提示并允许重试，不直接抛 traceback
        while True:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                break
            except Exception as exc:  # noqa: BLE001
                print(f"✘ 打开平台后台失败：{exc}")
                print("  请检查：1) 本机网络/代理；2) 平台入口地址是否变更"
                      "（可在 .env.local 配置 PLATFORM_URL 覆盖）")
                choice = await asyncio.get_running_loop().run_in_executor(
                    None, input, "按回车重试，输入 q 退出: ")
                if choice.strip().lower() == "q":
                    await context.close()
                    return False

        await asyncio.get_running_loop().run_in_executor(None, input, "登录完成后按回车继续...")

        status = await driver.check_status(page)
        if status == "online":
            print("✔ 登录态验证通过，已保存。可以启动 Worker 了。")
        else:
            print(f"✘ 登录态验证失败（status={status}），请重新运行本脚本完成登录。")
        await context.close()
        return status == "online"


def main():
    parser = argparse.ArgumentParser(description="RPA Worker 登录引导")
    parser.add_argument("--platform",
                        choices=["douyin", "douyin_enterprise", "xiaohongshu"], default=None)
    args = parser.parse_args()

    cfg = WorkerConfig.from_env()
    if args.platform:
        cfg.platform = args.platform
    ok = asyncio.run(guided_login(cfg))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
