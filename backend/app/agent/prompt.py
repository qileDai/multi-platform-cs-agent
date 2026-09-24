"""提示词加载与渲染：按文件 mtime 热更新，改提示词不用重启。"""
import os
from datetime import datetime

from ..config import settings

PROMPT_PATH = os.path.join(os.path.dirname(__file__), "..", "prompts", "cs_agent.md")

_cache: dict = {"mtime": 0.0, "content": ""}

PLATFORM_STYLES = {
    "douyin": "当前平台是抖音：用户偏年轻，喜欢直接、活泼、有梗的表达，可以适度玩梗，emoji 可以稍微多一点（每条仍最多 1 个）。",
    "xiaohongshu": "当前平台是小红书：用户喜欢种草式、姐妹感的语气，可以多用「姐妹」「宝子」这类称呼（不要每句都用），适度 emoji。",
    "mock": "当前是测试通道：保持自然口语化即可。",
}


def load_prompt() -> str:
    """按 mtime 热更新加载提示词。"""
    path = os.path.abspath(PROMPT_PATH)
    mtime = os.path.getmtime(path)
    if mtime != _cache["mtime"]:
        with open(path, "r", encoding="utf-8") as f:
            _cache["content"] = f.read()
        _cache["mtime"] = mtime
    return _cache["content"]


def render_prompt(*, platform: str, knowledge_context: str,
                  history_text: str, user_message: str,
                  customer_profile: str = "", rewritten_question: str = "") -> str:
    """渲染模板变量。新增参数默认为空，旧评测不用改用例。"""
    from . import tools  # 延迟导入，避免注册顺序问题
    template = load_prompt()
    return (
        template
        .replace("{{platform}}", platform)
        .replace("{{platform_style}}", PLATFORM_STYLES.get(platform, PLATFORM_STYLES["mock"]))
        .replace("{{knowledge_context}}", knowledge_context or "无匹配资料")
        .replace("{{history}}", history_text or "（无历史，这是用户的第一条消息）")
        .replace("{{user_message}}", user_message)
        .replace("{{customer_profile}}", customer_profile or "无")
        .replace("{{rewritten_question}}", rewritten_question or "")
        .replace("{{tools_section}}", tools.tools_prompt_text())
        .replace("{{current_time}}", datetime.now().strftime("%Y-%m-%d %H:%M"))
    )
