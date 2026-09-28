"""发出前的证据核对。事实只能来自检索正文、本次工具结果或人工原话。"""
import re

_AMOUNT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:元|块|折|件|%|天|小时|个月|月|年)")
_LOGISTICS = re.compile(r"中通|圆通|顺丰|韵达|申通|极兔|转运中心|[A-Za-z]{2,}\d{6,}")
_PAIRS = (
    ("不支持", "支持"),
    ("不包邮", "包邮"),
    ("不能退", "能退"),
    ("不可退", "可退"),
    ("不可以", "可以"),
)


def evidence_text(contexts: list[dict], tool_results: list[dict], agent_lines: list[str]) -> str:
    parts = [item.get("content") or "" for item in contexts]
    parts.extend(str(item) for item in tool_results)
    parts.extend(agent_lines)
    return "\n".join(parts)


def claims_unsupported(messages: list[str], evidence: str) -> bool:
    """回复里的数字、物流专名或相反政策在证据里对不上。"""
    blob = evidence or ""
    for message in messages:
        for match in _AMOUNT.finditer(message or ""):
            number = match.group(1)
            if re.search(rf"(?<!\d){re.escape(number)}(?!\d)", blob) is None:
                return True
        for token in _LOGISTICS.findall(message or ""):
            if token not in blob:
                return True
        if _polarity_conflict(message or "", blob):
            return True
    return False


def _polarity_conflict(reply: str, evidence: str) -> bool:
    for negative, positive in _PAIRS:
        reply_pos = positive in reply.replace(negative, "")
        reply_neg = negative in reply
        evidence_pos = positive in evidence.replace(negative, "")
        evidence_neg = negative in evidence
        if reply_pos and evidence_neg and not evidence_pos:
            return True
        if reply_neg and evidence_pos and not evidence_neg:
            return True
    return False
