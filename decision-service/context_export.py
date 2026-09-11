"""Read-only export of validated, unexpired research, never an order."""
import json
import math
from datetime import datetime, timezone
from decision_schema import validate_decision


def eligible(decision: dict) -> bool:
    try:
        return (not validate_decision(decision) and decision["status"] == "ready"
                and decision["market_data"]["freshness"]["level"] == "ready"
                and datetime.fromisoformat(decision["expires_at"].replace("Z", "+00:00")) > datetime.now(timezone.utc)
                and bool(decision.get("rationale_zh")) and math.isfinite(decision["confidence"])
                and decision["action_bias"] in {"long", "short", "wait", "close"})
    except (TypeError, KeyError, ValueError):
        return False


def latest_context(store_dir, symbol: str, timeframe: str) -> dict:
    for path in sorted(store_dir.glob("*.json"), reverse=True)[:200]:
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
            if row.get("symbol") != symbol or row.get("timeframe") != timeframe or not eligible(row):
                continue
            return {"status": "ready", "request_id": row["request_id"], "symbol": symbol, "timeframe": timeframe,
                    "expires_at": row["expires_at"], "action_bias": row["action_bias"], "confidence": row["confidence"],
                    "rationale": row["rationale_zh"][:1200], "market_data": row["market_data"]}
        except (OSError, ValueError, TypeError):
            continue
    return {"status": "unavailable", "symbol": symbol, "timeframe": timeframe, "reason": "No validated unexpired deep research"}
