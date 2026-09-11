"""圆衡 Enkei 外部 AI 终端 - 输出校验、元数据填充与修复重试

架构约定：
- 终端负责填充 version/policy_id/generated_at/expires_at/symbol/provider/model_id/model_version/timeframe/news_context；
- 模型只负责判断内容（regime/bias/confidence/recommended_model/conditions/invalidation/rationale）；
- 校验失败后做 1 次“仅修复 JSON”的短重试（总尝试最多 2 次）。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from . import config
from . import schemas


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def ttl_for(timeframe: str) -> int:
    return config.DEFAULT_TTL_SECONDS.get(timeframe, 360)


def new_policy_id() -> str:
    """生成稳定唯一 policy_id，用于关联决策/结果事件。"""
    return str(uuid.uuid4())


def build_state(policy: dict, degraded: str = "none", request_id: str = "") -> dict:
    """从政策对象构建统一判断 state（enkei-ai-state/v1，M1 契约）。

    state 是给圆衡主程序的唯一入口；source/provider/model_or_agent 反映实际判断来源。
    degraded 四态由调度层决定：none / fallback / stale / invalid。
    """
    generated = policy.get("generated_at", now_iso())
    ttl = ttl_for(policy.get("timeframe", "M5"))
    if not policy.get("expires_at"):
        from datetime import timedelta
        policy["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=ttl)) \
            .isoformat(timespec="seconds").replace("+00:00", "Z")

    provider = policy.get("provider", "none")
    direct_sources = {"ollama", "deepseek", "openai", "qwen", "zhipu", "gemini", "minimax", "groq", "openrouter", "custom"}
    source = "librechat" if provider in ("librechat", "librechat_agent") else (
        provider if provider in direct_sources else "none")

    regime = policy.get("market_regime", "uncertain")
    direction = policy.get("action_bias", "wait")
    action_plan = policy.get("action_plan") if isinstance(policy.get("action_plan"), dict) else {}
    rationale_zh = action_plan.get("rationale_zh") or policy.get("rationale_zh", "")

    features = policy.get("feature_summary") if isinstance(policy.get("feature_summary"), dict) else {}
    key_levels = {
        "notes": f"{policy.get('market_regime', 'uncertain')} 区间；依据近期{ttl//60}分钟结构",
    }
    # 旧政策可能没有区间高低点；省略缺失值，不能向 state 写入 None。
    for name in ("recent_high", "recent_low"):
        value = features.get(name)
        if isinstance(value, (int, float)):
            key_levels[name] = value

    state = {
        "state_id": f"st_{policy.get('policy_id', '')[:12]}",
        "version": "enkei-ai-state/v1",
        "symbol": policy.get("symbol", "USDJPY"),
        "timeframe": policy.get("timeframe", "M5"),
        "generated_at": generated,
        "valid_until": policy["expires_at"],
        "source": source,
        "provider": provider,
        "model_or_agent": policy.get("model_id") or policy.get("model_version") or "unknown",
        "regime": regime,
        "direction": direction,
        "confidence": int(policy.get("confidence", 0) or 0),
        "key_levels": key_levels,
        "conditions": {
            "entry": policy.get("entry_conditions", []),
            "scale_in": policy.get("scale_in_conditions", []),
            "exit": policy.get("exit_conditions", []),
        },
        "action_plan": {
            "recommended_model": policy.get("recommended_model", "trend-breakout"),
            "invalidation": policy.get("invalidation", ""),
            "rationale_zh": rationale_zh[:800],
        },
        "reassess_triggers": {
            "timeframe": policy.get("timeframe", "M5"),
            "ttl_seconds": ttl,
        },
        "degraded": degraded,
        "request_id": request_id,
        "policy_reference": {
            "policy_id": policy.get("policy_id", ""),
            "endpoint": "/v1/policies/current",
        },
    }
    return state


def build_policy(market_summary: dict, judgment: dict, provider_name: str, model_id: str, model_version: str,
                 news_context: list[str] | None = None, source: str = "ollama",
                 degraded: str = "none", request_id: str = "") -> dict:
    """用模型判断 + 终端元数据组装完整政策对象（enkei-ai-feedback/v2）。"""
    generated = now_iso()
    ttl = ttl_for(market_summary.get("timeframe", "M5"))
    from .data_quality import timestamp
    anchors = [timestamp(market_summary.get("generated_at")), timestamp((market_summary.get("quote") or {}).get("received_at"))]
    if any(value is None for value in anchors):
        raise ValueError("Market packet has no trustworthy timestamp")
    expires = min(anchors)
    # 源数据时刻 + TTL：慢推理不能刷新旧行情的有效期。
    from datetime import timedelta
    expires_iso = (expires + timedelta(seconds=ttl)).isoformat(timespec="seconds").replace("+00:00", "Z")

    # 终端而非模型负责枚举收敛：本地小模型偶尔会把策略模型名填到
    # market_regime。此处不猜测其意图，改为保守的 uncertain / wait，
    # 以保证输出契约和调用链保持可用。
    regimes = {"trend", "range", "volatile", "uncertain"}
    biases = {"long", "short", "wait", "close"}
    market_regime = judgment.get("market_regime")
    if market_regime not in regimes:
        market_regime = "uncertain"
    action_bias = judgment.get("action_bias")
    if action_bias not in biases:
        action_bias = "wait"

    # 推荐模型必须落在白名单；模型给错/缺失则回落规则模型自身
    recommended = judgment.get("recommended_model")
    allowed = ["trend-breakout", "ema-cross", "trend-pullback", "range-reversion", "momentum-pulse"]
    if recommended not in allowed:
        recommended = market_summary.get("execution_context", {}).get("selected_rule_model")
        if recommended not in allowed:
            recommended = "trend-breakout"

    def norm_conditions(v, default=[]) -> list:
        if not isinstance(v, list):
            return []
        return [str(x) for x in v][:5]

    def bounded_confidence(value) -> int:
        try:
            return max(0, min(100, int(value)))
        except (TypeError, ValueError):
            return 0

    # 新闻上下文：仅保留字符串、去重、最多 10 条
    if not isinstance(news_context, list):
        news_context = []
    seen = set()
    news: list[str] = []
    for x in news_context:
        s = str(x).strip()
        if s and s not in seen:
            seen.add(s)
            news.append(s)
        if len(news) >= 10:
            break

    policy = {
        "version": "enkei-ai-feedback/v2",
        "policy_id": new_policy_id(),
        "news_context": news,
        "generated_at": generated,
        "expires_at": expires_iso,
        "symbol": market_summary.get("symbol", "USDJPY"),
        "provider": provider_name,
        "model_id": model_id,
        "model_version": model_version,
        "timeframe": market_summary.get("timeframe", "M5"),
        "source": source,
        "degraded": degraded,
        "request_id": request_id,
        "market_regime": market_regime,
        "action_bias": action_bias,
        "confidence": bounded_confidence(judgment.get("confidence", 0)),
        "recommended_model": recommended,
        "entry_conditions": norm_conditions(judgment.get("entry_conditions")),
        "scale_in_conditions": norm_conditions(judgment.get("scale_in_conditions")),
        "exit_conditions": norm_conditions(judgment.get("exit_conditions")),
        "invalidation": str(judgment.get("invalidation", "") or ""),
        "rationale_zh": str(judgment.get("rationale_zh", "") or "")[:800],
        "rationale_ja": str(judgment.get("rationale_ja", "") or "")[:800] or None,
        "rationale_en": str(judgment.get("rationale_en", "") or "")[:800] or None,
        "feature_summary": {
            "last_price": (market_summary.get("quote") or {}).get("bid"),
            "spread_pips": (market_summary.get("quote") or {}).get("spread_pips"),
            "recent_high": (market_summary.get("features") or {}).get("recent_high"),
            "recent_low": (market_summary.get("features") or {}).get("recent_low"),
        },
    }
    # 去掉空翻译与 feature_summary 空值，避免 additionalProperties/类型问题
    for name in ("rationale_ja", "rationale_en"):
        if policy[name] is None:
            del policy[name]
    if policy["feature_summary"]["last_price"] is None:
        policy["feature_summary"]["last_price"] = 0.0
    if policy["feature_summary"]["spread_pips"] is None:
        policy["feature_summary"]["spread_pips"] = 0.0
    for name in ("recent_high", "recent_low"):
        if policy["feature_summary"][name] is None:
            del policy["feature_summary"][name]
    return policy


def repair_prompt(original_text: str, errors: list[str]) -> str:
    """生成仅修复 JSON 的短提示词。"""
    err = "；".join(errors[:3])
    return (
        "下面是你上一次的输出，它不是合法 JSON 或字段不满足要求。"
        f"错误：{err}\n"
        "请只输出修正后的 JSON 对象，不要任何其他文字、解释或 Markdown。\n\n"
        f"上次输出：\n{original_text[:1500]}"
    )
