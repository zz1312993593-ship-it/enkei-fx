# -*- coding: utf-8 -*-
"""圆衡 Enkei 决策服务 - 协议 schema（严格 JSON Schema 校验）

输入：POST /v1/signal（入参：symbol / timeframe / 可选摘要说明）
输出：GET /v1/decision（标准化决策，携带数据来源/时间戳/模型与框架版本/有效期/证据引用）
"""
from __future__ import annotations

import json
from datetime import datetime

from jsonschema import Draft202012Validator, FormatChecker

SIGNAL_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Enkei Deep Signal Request v1",
    "type": "object",
    "required": ["symbol", "timeframe"],
    "properties": {
        "symbol": {"type": "string", "enum": ["USDJPY", "EURUSD", "EURJPY", "GBPUSD", "GBPJPY", "AUDJPY"]},
        "timeframe": {"type": "string", "enum": ["M5", "M15", "H1"]},
        "limit": {"type": "integer", "minimum": 20, "maximum": 500},
        "note": {"type": "string", "maxLength": 500},
    },
    "additionalProperties": False,
}

# 决策有效期：M5=8min / M15=25min / H1=80min（略大于一个周期，宽松给 TTL）
DECISION_TTL_BY_TIMEFRAME = {"M5": 8 * 60, "M15": 25 * 60, "H1": 80 * 60}

DECISION_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Enkei Deep Decision v1",
    "type": "object",
    "required": [
        "version", "request_id", "status", "symbol", "timeframe",
        "generated_at", "expires_at", "framework", "provider",
        "signal", "action_bias", "confidence", "regime",
        "market_data", "evidence",
    ],
    "properties": {
        "version": {"type": "string", "const": "enkei-decision/v1"},
        "request_id": {"type": "string", "minLength": 1},
        "status": {"type": "string", "enum": ["pending", "ready", "failed", "observe-only"]},
        "symbol": {"type": "string", "pattern": "^[A-Z]{6}$"},
        "timeframe": {"type": "string", "enum": ["M5", "M15", "H1"]},
        "generated_at": {"type": "string", "format": "date-time"},
        "expires_at": {"type": "string", "format": "date-time"},
        "framework": {
            "type": "object",
            "required": ["name", "version"],
            "properties": {
                "name": {"type": "string"},
                "version": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "provider": {
            "type": "object",
            "required": ["kind", "model_or_agent"],
            "properties": {
                "kind": {"type": "string"},
                "model_or_agent": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "signal": {"type": "string", "enum": ["Strong Buy", "Buy", "Overweight", "Hold", "Underweight", "Sell", "Strong Sell", "None"]},
        "action_bias": {"type": "string", "enum": ["long", "short", "wait", "close", "observe"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 100},
        "regime": {"type": "string", "enum": ["trend", "range", "volatile", "uncertain"]},
        "rationale_zh": {"type": "string", "maxLength": 2000},
        "volume": {"type": "object", "properties": {"estimate_bars": {"type": "integer"}}, "additionalProperties": False},
        "market_data": {
            "type": "object",
            "required": ["source", "fetched_at", "latest_bar_time", "freshness"],
            "properties": {
                "source": {"type": "string"},
                "fetched_at": {"type": "string", "format": "date-time"},
                "latest_bar_time": {"type": ["number", "null"]},
                "file_age_ms": {"type": ["number", "null"]},
                "total_bars": {"type": ["number", "null"]},
                "clock": {"type": "object"},
                "freshness": {"type": "object", "required": ["level"], "properties": {"level": {"type": "string"}, "reasons": {"type": "array"}}, "additionalProperties": False},
            },
            "additionalProperties": False,
        },
        "analyst_reports": {
            "type": "object",
            "properties": {
                "market_len": {"type": "integer"},
                "news_len": {"type": "integer"},
                "sentiment_len": {"type": "integer"},
                "fundamentals_len": {"type": "integer"},
            },
            "additionalProperties": False,
        },
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "role": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "decision_text": {"type": "string"},
        "note": {"type": "string"},
        "error": {"type": "string"},
        "elapsed_s": {"type": "number"},
    },
    "additionalProperties": False,
}


_signal_input_validator = Draft202012Validator(SIGNAL_INPUT_SCHEMA, format_checker=FormatChecker())
# Draft202012Validator 默认不会执行 format 校验；显式启用后，generated_at /
# expires_at / fetched_at 等字段才真正受 date-time 契约约束。
_decision_validator = Draft202012Validator(DECISION_SCHEMA, format_checker=FormatChecker())


def validate_signal_input(data: dict) -> list[str]:
    return [e.message for e in sorted(_signal_input_validator.iter_errors(data), key=lambda e: list(e.path))]


def validate_decision(data: dict) -> list[str]:
    errors = [e.message for e in sorted(_decision_validator.iter_errors(data), key=lambda e: list(e.path))]
    # 当前精简 venv 没有安装 jsonschema date-time 的可选校验依赖，
    # FormatChecker 会静默把未知 format 当作通过。对审计时间不能依赖该行为。
    for field in ("generated_at", "expires_at"):
        value = data.get(field)
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError("timezone required")
            except ValueError:
                errors.append(f"{field} 不是带时区的 ISO 8601 时间")
    market_data = data.get("market_data")
    if isinstance(market_data, dict):
        value = market_data.get("fetched_at")
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError("timezone required")
            except ValueError:
                errors.append("market_data.fetched_at 不是带时区的 ISO 8601 时间")
    return errors


def to_json_str(schema: dict) -> str:
    return json.dumps(schema, ensure_ascii=False, indent=2)
