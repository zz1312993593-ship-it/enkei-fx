"""圆衡 Enkei 外部 AI 终端 - 协议 schema（对齐交接包 AI_市场摘要输入协议草案.json / AI_接口协议草案.json）"""
from __future__ import annotations

import json

from jsonschema import Draft202012Validator

# ============ 输入协议 enkei-market-summary/v1 ============
INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Enkei Market Summary v1",
    "type": "object",
    "required": ["version", "generated_at", "symbol", "timeframe", "quote", "features", "bars", "execution_context"],
    "properties": {
        "language": {"type": "string", "enum": ["zh", "ja", "en"]},
        "version": {"type": "string", "const": "enkei-market-summary/v1"},
        "generated_at": {"type": "string", "format": "date-time"},
        "symbol": {"type": "string", "pattern": "^[A-Z]{6}$"},
        "timeframe": {"type": "string", "enum": ["M1", "M5", "M15"]},
        "quote": {
            "type": "object",
            "required": ["bid", "ask", "spread_pips", "received_at"],
            "properties": {
                "bid": {"type": "number"},
                "ask": {"type": "number"},
                "spread_pips": {"type": "number", "minimum": 0},
                "received_at": {"type": "string", "format": "date-time"},
            },
            "additionalProperties": False,
        },
        "features": {
            "type": "object",
            "required": ["ema_fast", "ema_slow", "momentum", "recent_high", "recent_low", "range_pips"],
            "properties": {
                "ema_fast": {"type": "number"},
                "ema_slow": {"type": "number"},
                "momentum": {"type": "number"},
                "recent_high": {"type": "number"},
                "recent_low": {"type": "number"},
                "range_pips": {"type": "number", "minimum": 0},
            },
            "additionalProperties": False,
        },
        "bars": {
            "type": "array",
            "minItems": 20,
            "maxItems": 120,
            "items": {
                "type": "object",
                "required": ["time", "open", "high", "low", "close"],
                "properties": {
                    "time": {"type": "string", "format": "date-time"},
                    "open": {"type": "number"},
                    "high": {"type": "number"},
                    "low": {"type": "number"},
                    "close": {"type": "number"},
                },
                "additionalProperties": False,
            },
        },
        "execution_context": {
            "type": "object",
            "required": ["selected_rule_model", "positions", "previous_policy"],
            "properties": {
                "selected_rule_model": {"type": "string"},
                "positions": {"type": "array", "maxItems": 10, "items": {"type": "object"}},
                "previous_policy": {"type": ["object", "null"]},
            },
            "additionalProperties": False,
        },
    },
    "additionalProperties": False,
}

# ============ 输出协议 enkei-ai-feedback/v2 ============
# v2 相对 v1 新增：policy_id（稳定唯一，关联决策/结果事件）、news_context（本次判断实际用到的新闻标识）。
OUTPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Enkei AI Market Feedback v2",
    "type": "object",
    "required": [
        "version", "generated_at", "expires_at", "symbol", "provider", "model_id",
        "model_version", "timeframe", "market_regime", "action_bias", "confidence",
        "recommended_model", "entry_conditions", "scale_in_conditions",
        "exit_conditions", "rationale_zh", "invalidation",
        "policy_id", "news_context", "request_id",
    ],
    "properties": {
        "version": {"type": "string", "const": "enkei-ai-feedback/v2"},
        "generated_at": {"type": "string", "format": "date-time"},
        "expires_at": {"type": "string", "format": "date-time"},
        "policy_id": {"type": "string", "minLength": 1},
        "request_id": {"type": "string", "minLength": 1},
        "news_context": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
        "symbol": {"type": "string", "pattern": "^[A-Z]{6}$"},
        "provider": {"type": "string", "enum": ["ollama", "deepseek", "openai", "qwen", "zhipu", "gemini", "minimax", "groq", "openrouter", "custom", "librechat"]},
        "model_id": {"type": "string", "minLength": 1},
        "model_version": {"type": "string", "minLength": 1},
        "timeframe": {"type": "string", "enum": ["M1", "M5", "M15"]},
        "source": {"type": "string", "enum": ["librechat", "ollama", "deepseek", "openai", "qwen", "zhipu", "gemini", "minimax", "groq", "openrouter", "custom", "none"]},
        "degraded": {"type": "string", "enum": ["none", "fallback", "stale", "invalid"]},
        "market_regime": {"type": "string", "enum": ["trend", "range", "volatile", "uncertain"]},
        "action_bias": {"type": "string", "enum": ["long", "short", "wait", "close"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 100},
        "recommended_model": {"type": "string", "enum": ["trend-breakout", "ema-cross", "trend-pullback", "range-reversion", "momentum-pulse"]},
        "entry_conditions": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "scale_in_conditions": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "exit_conditions": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "invalidation": {"type": "string"},
        "rationale_zh": {"type": "string", "maxLength": 800},
        "rationale_ja": {"type": "string", "maxLength": 800},
        "rationale_en": {"type": "string", "maxLength": 800},
        "feature_summary": {
            "type": "object",
            "properties": {
                "last_price": {"type": "number"},
                "spread_pips": {"type": "number"},
                "recent_high": {"type": "number"},
                "recent_low": {"type": "number"},
                "trend_summary": {"type": "string"},
                "volatility_summary": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    "additionalProperties": False,
}

# ============ 统一判断状态契约 enkei-ai-state/v1（M1） ============
# 主程序只读 state，不直接理解 LibreChat 的会话/模型/流式/认证细节。
# degraded 四态：none（主链路正常）/ fallback（降级到本地 Ollama）/
#               stale（无可替代，旧政策已过期）/ invalid（有记录但无法形成有效判断）。
STATE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Enkei AI State v1",
    "type": "object",
    "required": [
        "state_id", "version", "symbol", "timeframe", "generated_at", "valid_until",
        "source", "provider", "model_or_agent", "regime", "direction", "confidence",
        "key_levels", "conditions", "action_plan", "reassess_triggers",
        "degraded", "request_id", "policy_reference",
    ],
    "properties": {
        "state_id": {"type": "string", "minLength": 1},
        "version": {"type": "string", "const": "enkei-ai-state/v1"},
        "symbol": {"type": "string", "pattern": "^[A-Z]{6}$"},
        "timeframe": {"type": "string", "enum": ["M5", "M15"]},
        "generated_at": {"type": "string", "format": "date-time"},
        "valid_until": {"type": "string", "format": "date-time"},
        "source": {"type": "string", "enum": ["librechat", "ollama", "deepseek", "openai", "qwen", "zhipu", "gemini", "minimax", "groq", "openrouter", "custom", "none"]},
        "provider": {"type": "string"},
        "model_or_agent": {"type": "string"},
        "regime": {"type": "string", "enum": ["trend", "range", "volatile", "uncertain"]},
        "direction": {"type": "string", "enum": ["long", "short", "wait", "close"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 100},
        "key_levels": {
            "type": "object",
            "properties": {
                "recent_high": {"type": "number"},
                "recent_low": {"type": "number"},
                "notes": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "conditions": {
            "type": "object",
            "properties": {
                "entry": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
                "scale_in": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
                "exit": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
            },
            "additionalProperties": False,
        },
        "action_plan": {
            "type": "object",
            "properties": {
                "recommended_model": {"type": "string"},
                "invalidation": {"type": "string"},
                "rationale_zh": {"type": "string", "maxLength": 800},
            },
            "additionalProperties": False,
        },
        "reassess_triggers": {
            "type": "object",
            "properties": {
                "timeframe": {"type": "string"},
                "ttl_seconds": {"type": "integer"},
            },
            "additionalProperties": False,
        },
        "degraded": {"type": "string", "enum": ["none", "fallback", "stale", "invalid"]},
        "request_id": {"type": "string"},
        "policy_reference": {
            "type": "object",
            "properties": {
                "policy_id": {"type": "string"},
                "endpoint": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    "additionalProperties": False,
}

_state_validator = Draft202012Validator(STATE_SCHEMA)


def validate_state(data: dict) -> list[str]:
    """校验 state 对象，返回错误列表（空=合法）。"""
    return [e.message for e in sorted(_state_validator.iter_errors(data), key=lambda e: list(e.path))]


_input_validator = Draft202012Validator(INPUT_SCHEMA)
_output_validator = Draft202012Validator(OUTPUT_SCHEMA)


def validate_input(data: dict) -> list[str]:
    """校验输入市场摘要，返回错误列表（空=合法）。"""
    return [e.message for e in sorted(_input_validator.iter_errors(data), key=lambda e: list(e.path))]


def validate_output(data: dict) -> list[str]:
    """校验 AI 输出政策，返回错误列表（空=合法）。"""
    return [e.message for e in sorted(_output_validator.iter_errors(data), key=lambda e: list(e.path))]


def to_json_str(schema: dict) -> str:
    return json.dumps(schema, ensure_ascii=False, indent=2)
