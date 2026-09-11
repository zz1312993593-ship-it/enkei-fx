"""Shared fail-closed checks for market packets and model conclusions."""
from __future__ import annotations

import math
from datetime import datetime, timezone


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def market_errors(packet: dict) -> list[str]:
    from .schemas import validate_input
    errors = validate_input(packet)
    if errors:
        return errors
    now = datetime.now(timezone.utc)
    for label, value in (("generated_at", packet.get("generated_at")), ("quote.received_at", packet["quote"].get("received_at"))):
        at = timestamp(value)
        if at is None or not -5 <= (now - at).total_seconds() <= 120:
            errors.append(f"{label}: missing, future or older than 120 seconds")
    q = packet["quote"]
    if not all(finite(q.get(k)) for k in ("bid", "ask", "spread_pips")) or not 0 < q["bid"] <= q["ask"]:
        errors.append("quote: invalid bid/ask/spread")
    if not all(finite(v) for v in packet["features"].values()):
        errors.append("features: non-finite number")
    prior = None
    for bar in packet["bars"]:
        at = timestamp(bar["time"])
        if at is None or (at - now).total_seconds() > 5 or (prior is not None and at <= prior):
            errors.append("bars: invalid or unordered timestamps")
            break
        prior = at
        if not all(finite(bar.get(k)) and bar[k] > 0 for k in ("open", "high", "low", "close")) or not bar["low"] <= min(bar["open"], bar["close"]) <= max(bar["open"], bar["close"]) <= bar["high"]:
            errors.append("bars: invalid OHLC")
            break
    seconds = {"M1": 60, "M5": 300, "M15": 900}.get(packet["timeframe"], 60)
    if prior is None or (now - prior).total_seconds() > seconds * 2 + 120:
        errors.append("bars: history is stale")
    return errors


def judgment_errors(result) -> list[str]:
    if not isinstance(result, dict):
        return ["judgment must be an object"]
    errors = []
    for key, allowed in (("market_regime", {"trend", "range", "volatile", "uncertain"}), ("action_bias", {"long", "short", "wait", "close"}), ("recommended_model", {"trend-breakout", "ema-cross", "trend-pullback", "range-reversion", "momentum-pulse"})):
        if not isinstance(result.get(key), str) or result[key] not in allowed:
            errors.append(f"{key}: invalid or missing")
    if not finite(result.get("confidence")) or not 0 <= result["confidence"] <= 100:
        errors.append("confidence: invalid or missing")
    if not isinstance(result.get("rationale_zh"), str) or not result["rationale_zh"].strip():
        errors.append("rationale_zh: empty")
    # 超长输出与空输出同属不可发布：与 schemas.py 的 maxLength(800) 保持一致，
    # 在质量门直接拒绝，避免把失控生成写进政策库。
    for key in ("rationale_zh", "rationale_ja"):
        value = result.get(key)
        if isinstance(value, str) and len(value) > 800:
            errors.append(f"{key}: exceeds 800-char limit")
    return errors


def report_errors(result) -> list[str]:
    if not isinstance(result, dict):
        return ["report must be an object"]
    errors = []
    thesis = result.get("thesis")
    if not isinstance(thesis, dict):
        return ["thesis: missing"]
    for key in ("short_bias", "mid_bias"):
        if not isinstance(thesis.get(key), str) or thesis[key] not in {"long", "short", "wait"}:
            errors.append(f"thesis.{key}: invalid")
    if not finite(thesis.get("confidence")) or not 0 <= thesis["confidence"] <= 100:
        errors.append("thesis.confidence: invalid")
    for value in (result.get("headline"), thesis.get("summary"), result.get("source_assessment")):
        if not isinstance(value, str) or not value.strip():
            errors.append("headline/summary/source_assessment must be nonempty")
    for key in ("drivers", "risks", "next_checks"):
        rows = result.get(key)
        if not isinstance(rows, list) or not rows or any(not isinstance(x, str) or not x.strip() for x in rows):
            errors.append(f"{key}: expected nonempty text list")
    levels = result.get("key_levels")
    if not isinstance(levels, list) or any(not isinstance(x, dict) or not isinstance(x.get("label"), str) or not x["label"].strip() or not finite(x.get("price")) or x["price"] <= 0 for x in (levels or [])):
        errors.append("key_levels: expected [{label, price}] or []")
    return errors
