"""圆衡 Enkei 外部 AI 终端 - 日志与输出统一脱敏层"""
from __future__ import annotations

import re
from typing import Any

from . import config


def _mask_value(key: str, value: Any) -> Any:
    """对敏感键名对应的值打码；非字符串类型原样返回。"""
    low = key.lower()
    if any(s in low for s in config.SENSITIVE_KEYS):
        if isinstance(value, str) and value:
            return "<redacted>"
        if isinstance(value, (dict, list)):
            return "<redacted>"
        return value
    return value


def sanitize(obj: Any) -> Any:
    """递归脱敏：键名含敏感词的值打码，字符串中的密钥串打码。"""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            masked = _mask_value(k, v)
            out[k] = sanitize(masked) if isinstance(masked, (dict, list)) else masked
        return out
    if isinstance(obj, list):
        return [sanitize(x) if isinstance(x, (dict, list)) else x for x in obj]
    if isinstance(obj, str):
        s = obj
        for pat, repl in config.SENSITIVE_PATTERNS:
            s = re.sub(pat, repl, s)
        return s
    return obj


def safe_log(prefix: str, obj: Any) -> str:
    """生成脱敏后的日志行。"""
    try:
        import json
        return f"{prefix} {json.dumps(sanitize(obj), ensure_ascii=False)}"
    except Exception:
        return f"{prefix} <unserializable>"
