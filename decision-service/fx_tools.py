"""FX research tool boundary: never resolve an FX pair via equity/crypto vendors."""
import json
import httpx


def read_news(symbol: str) -> list[dict]:
    """Reuse the terminal's existing news cache; never refresh or pay to translate."""
    try:
        with httpx.Client(timeout=3, trust_env=False) as client:
            runtime = client.get("http://127.0.0.1:8787/api/status").json()
            port = int(runtime.get("ai_terminal", {}).get("port", 8710))
            if not 1024 <= port <= 65535:
                return []
            response = client.get(f"http://127.0.0.1:{port}/v1/news", params={"symbol": symbol, "limit": 6, "language": "en"})
            response.raise_for_status()
            return [{k: row.get(k) for k in ("title", "body", "source", "published", "link")} for row in response.json().get("items", [])[:6] if isinstance(row, dict)]
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return []


def snapshot_tool_output(name: str, snapshot: dict, arguments: dict) -> str:
    requested = arguments.get("symbol") or arguments.get("ticker")
    if requested and str(requested).replace("/", "").upper() != snapshot["symbol"]:
        return json.dumps({"status": "unavailable", "reason": "symbol mismatch"})
    if name in {"get_stock_data", "get_verified_market_snapshot"}:
        payload = {k: snapshot.get(k) for k in ("symbol", "timeframe", "generated_at", "quote", "bars", "features", "market_data")}
    elif name == "get_indicators":
        payload = {"symbol": snapshot["symbol"], "timeframe": snapshot["timeframe"], "features": snapshot["features"],
                   "note": "Only these computed FX features are available. Do not substitute an unsupported indicator."}
    elif name in {"get_news", "get_global_news"} and snapshot.get("news_evidence"):
        payload = {"symbol": snapshot["symbol"], "news_evidence": snapshot["news_evidence"], "note": "Cached source excerpts, not full articles. Observe each publication time."}
    else:
        payload = {"status": "unavailable", "reason": "No verified source for this tool in the current FX packet; state this limitation, do not invent data."}
    return json.dumps(payload, ensure_ascii=False, allow_nan=False)


def create_fx_tool_nodes(snapshot: dict):
    from langchain_core.tools import StructuredTool
    from langgraph.prebuilt import ToolNode
    from tradingagents.agents.utils import agent_utils
    def wrap(name):
        original = getattr(agent_utils, name)
        def run_tool(_name=name, **kwargs):
            return snapshot_tool_output(_name, snapshot, kwargs)
        return StructuredTool.from_function(
            func=run_tool,
            name=name, description=original.description, args_schema=original.args_schema)
    return {
        "market": ToolNode([wrap(n) for n in ("get_stock_data", "get_indicators", "get_verified_market_snapshot")]),
        "news": ToolNode([wrap(n) for n in ("get_news", "get_global_news", "get_macro_indicators", "get_prediction_markets")]),
    }
