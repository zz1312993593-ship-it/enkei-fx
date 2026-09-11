"""Optional read-only research context; never triggers paid inference or orders."""
from datetime import datetime, timezone
import httpx
from .data_quality import timestamp, finite


def render_context(row: dict, symbol: str, timeframe: str) -> str:
    if not isinstance(row, dict) or row.get("status") != "ready" or row.get("symbol") != symbol or row.get("timeframe") != timeframe:
        return ""
    expires = timestamp(row.get("expires_at"))
    confidence = row.get("confidence")
    if not expires or expires <= datetime.now(timezone.utc) or not finite(confidence) or not 0 <= confidence <= 100:
        return ""
    if row.get("action_bias") not in {"long", "short", "wait", "close"} or not isinstance(row.get("rationale"), str) or not row["rationale"].strip():
        return ""
    return (f"【深度研究 {symbol}/{timeframe} request_id={row.get('request_id')} 有效至 {row['expires_at']}】\n"
            f"方向={row['action_bias']}；模型自报置信度={confidence}（不是胜率）；{row['rationale'][:1200]}\n"
            "这只是研究证据，不是订单；必须与本次最新行情共同评估。")


async def fetch_context(symbol: str, timeframe: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            response = await client.get("http://127.0.0.1:8792/v1/context", params={"symbol": symbol, "timeframe": timeframe})
            response.raise_for_status()
            return render_context(response.json(), symbol, timeframe)
    except (httpx.HTTPError, ValueError, TypeError):
        return ""
