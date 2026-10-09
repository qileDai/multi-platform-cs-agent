"""账号职责绑定：driver 与平台、职责、出站消息类型的对应关系。"""

DRIVERS: dict[str, dict] = {
    "douyin_feige": {
        "platform": "douyin", "duty": "dm", "label": "抖音飞鸽私信",
        "msg_types": ["text", "image", "voice"],
    },
    "douyin_enterprise": {
        "platform": "douyin", "duty": "dm", "label": "抖音企业号私信",
        "msg_types": ["text", "image", "voice"],
    },
    "xhs_ark": {
        "platform": "xiaohongshu", "duty": "dm", "label": "小红书千帆私信",
        "msg_types": ["text", "image", "voice"],
    },
    "douyin_comment": {
        "platform": "douyin", "duty": "comment", "label": "抖音企业号评论",
        "msg_types": ["comment_reply", "first_comment"],
    },
    "xhs_comment": {
        "platform": "xiaohongshu", "duty": "comment", "label": "小红书评论",
        "msg_types": ["comment_reply", "first_comment"],
    },
    "xhs_publish": {
        "platform": "xiaohongshu", "duty": "publish", "label": "小红书发布",
        "msg_types": ["publish_note", "collect_stats", "collect_account"],
    },
}

DUTIES = ("dm", "comment", "publish")
PROVIDERS = ("adspower", "local")
DISABLED = "disabled"


def driver_spec(driver: str) -> dict | None:
    return DRIVERS.get(driver)


def is_enabled(auth_status: str) -> bool:
    return auth_status != DISABLED
