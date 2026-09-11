"""统一分析体的本地可审计请求记录。

LibreChat Agents 的 OpenAI 兼容入口是无状态调用：它会执行 Agent，但不会把
请求写成 LibreChat 网页中的普通聊天会话。因此圆衡保存一份脱敏的请求链路，
让用户能确认实际送入了哪些行情/研究上下文，以及最终产生了什么结果。
"""
from __future__ import annotations

import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

_FILE = config.AUDIT_DIR / "analysis-traces.json"
_MAX_RECORDS = 2000
AUDIT_SCHEMA = "enkei-analysis-audit/v2"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _digest(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _safe_packet(summary: dict) -> dict:
    """保存可核对的市场摘要，只保留分析所需的脱敏执行上下文。"""
    bars = summary.get("bars") if isinstance(summary.get("bars"), list) else []
    latest = bars[-1] if bars and isinstance(bars[-1], dict) else {}
    quote = summary.get("quote") if isinstance(summary.get("quote"), dict) else {}
    recent_bars = []
    for bar in bars[-20:]:
        if not isinstance(bar, dict):
            continue
        recent_bars.append({key: bar.get(key) for key in ("time", "open", "high", "low", "close", "volume") if key in bar})
    execution = summary.get("execution_context") if isinstance(summary.get("execution_context"), dict) else {}
    positions = []
    for position in execution.get("positions", []) if isinstance(execution.get("positions"), list) else []:
        if isinstance(position, dict):
            positions.append({key: position.get(key) for key in ("side", "lots", "open_price", "profit") if key in position})
    previous = execution.get("previous_policy") if isinstance(execution.get("previous_policy"), dict) else {}
    missing = []
    if not quote: missing.append("quote")
    if not bars: missing.append("bars")
    if not isinstance(summary.get("features"), dict) or not summary.get("features"): missing.append("features")
    packet = {
        "symbol": summary.get("symbol"),
        "timeframe": summary.get("timeframe"),
        "language": summary.get("language", "zh"),
        "generated_at": summary.get("generated_at"),
        "quote": {key: quote.get(key) for key in ("bid", "ask", "mid", "spread_pips", "timestamp", "received_at") if key in quote},
        "bars": {
            "count": len(bars),
            "first_time": bars[0].get("time") if bars and isinstance(bars[0], dict) else None,
            "last_time": latest.get("time"),
            "last_close": latest.get("close"),
        },
        "recent_bars": recent_bars,
        "features": summary.get("features") if isinstance(summary.get("features"), dict) else {},
        "execution_context": {
            "selected_rule_model": execution.get("selected_rule_model"),
            "positions": positions,
            "previous_policy": {key: previous.get(key) for key in ("policy_id", "action_bias", "confidence", "expires_at") if key in previous},
        },
        "missing_data": missing,
    }
    packet["digest"] = _digest(packet)
    return packet


class AnalysisAuditStore:
    def __init__(self, path: Path = _FILE):
        self.path = path
        self._lock = threading.RLock()
        self._rows = self._load()

    def _load(self) -> list[dict]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def _save(self) -> bool:
        """原子写入；审计目录异常不能阻塞交易安全链路。"""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(self._rows[-_MAX_RECORDS:], ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(self.path)
            return True
        except OSError:
            # 调度器会继续拒绝不合格数据/保留旧政策；日志由调用端的常规 request_id 链路覆盖。
            return False

    def submitted(self, request_id: str, summary: dict, *, agent_id: str, context: dict,
                  requested_provider: str | None = None,
                  requested_model: str | None = None,
                  display_name: str | None = None,
                  route: str | None = None,
                  submitted_to_model: bool = True,
                  prompt_version: str = "enkei-system-prompt/v1",
                  protocol_version: str = "enkei-analysis-protocol/v2") -> None:
        started_at = _now()
        row = {
            "schema": AUDIT_SCHEMA,
            "analysis_id": f"analysis_{uuid.uuid4().hex[:16]}",
            "request_id": request_id,
            "created_at": started_at,
            "request_started_at": started_at,
            "model_response_started_at": None,
            "request_finished_at": None,
            "latency_ms": None,
            "first_response_ms": None,
            "status": "submitted" if submitted_to_model else "validating",
            "transport": route or "pending",
            "route": route or "pending",
            "agent_id": agent_id or None,
            "requested_provider": requested_provider,
            "requested_model_id": requested_model,
            "display_name": display_name or requested_model,
            "actual_provider": None,
            "actual_model_id": None,
            "effective_model_id": None,
            "degraded": False,
            "degrade_reason": None,
            "local_fallback_enabled": False,
            "local_fallback_used": False,
            "retry_count": 0,
            "attempts": [],
            "system_prompt_version": prompt_version,
            "analysis_protocol_version": protocol_version,
            "submitted_to_model": submitted_to_model,
            "market_packet": _safe_packet(summary),
            "context": context,
            "timeline": [{"at": started_at, "stage": "analysis_preparing"},
                         {"at": started_at, "stage": "submitted_to_model" if submitted_to_model else "validation_rejected"}],
            "result": None,
            "token_usage": None,
            "error_type": None,
            "error": None,
        }
        with self._lock:
            self._rows = [item for item in self._rows if item.get("request_id") != request_id]
            self._rows.append(row)
            self._save()

    def attempt(self, request_id: str, *, provider: str, model_id: str | None,
                route: str, status: str, error_type: str | None = None,
                error: str | None = None) -> None:
        """Append one real routing attempt without ever trusting model self-identification."""
        at = _now()
        with self._lock:
            for row in reversed(self._rows):
                if row.get("request_id") != request_id:
                    continue
                attempts = row.setdefault("attempts", [])
                attempts.append({"attempt": len(attempts) + 1, "at": at,
                                 "provider": provider, "model_id": model_id,
                                 "route": route, "status": status,
                                 "error_type": error_type,
                                 "error": (error or "")[:500] or None})
                row["retry_count"] = max(0, len(attempts) - 1)
                row.setdefault("timeline", []).append({"at": at, "stage": "model_attempt",
                                                       "provider": provider, "route": route,
                                                       "status": status})
                self._save()
                return

    def finished(self, request_id: str, *, status: str, result: dict | None = None,
                 error: str | None = None, error_type: str | None = None,
                 actual_provider: str | None = None,
                 actual_model_id: str | None = None,
                 route: str | None = None, degraded: bool = False,
                 degrade_reason: str | None = None,
                 local_fallback_used: bool = False) -> None:
        finished_at = _now()
        with self._lock:
            for row in reversed(self._rows):
                if row.get("request_id") == request_id:
                    row["status"] = status
                    row["finished_at"] = finished_at
                    row["request_finished_at"] = finished_at
                    if row.get("submitted_to_model", True):
                        row["model_response_started_at"] = row.get("model_response_started_at") or finished_at
                    try:
                        start = datetime.fromisoformat(str(row["request_started_at"]).replace("Z", "+00:00"))
                        end = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
                        row["latency_ms"] = max(0, int((end - start).total_seconds() * 1000))
                        row["first_response_ms"] = row["latency_ms"]
                    except Exception:
                        pass
                    row["actual_provider"] = actual_provider or (result or {}).get("source")
                    row["actual_model_id"] = actual_model_id or (result or {}).get("model_id")
                    row["effective_model_id"] = row["actual_model_id"]
                    if route:
                        row["route"] = route
                        row["transport"] = route
                    row["degraded"] = bool(degraded)
                    row["degrade_reason"] = degrade_reason
                    row["local_fallback_used"] = bool(local_fallback_used)
                    row["result"] = result
                    row["token_usage"] = (result or {}).get("token_usage")
                    row["error_type"] = error_type
                    row["error"] = (error or "")[:500] or None
                    row.setdefault("timeline", []).append({"at": finished_at,
                                                           "stage": "model_returned" if status == "succeeded" else status})
                    self._save()
                    return

    def list(self, symbol: str | None = None, limit: int = 30) -> list[dict]:
        with self._lock:
            rows = list(reversed(self._rows))
            if symbol:
                rows = [row for row in rows if row.get("market_packet", {}).get("symbol") == symbol]
            return rows[:limit]

    def usage_summary(self) -> dict:
        """Aggregate actual usage reported by providers; missing usage stays explicit."""
        with self._lock:
            rows = list(self._rows)
        totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        today_totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        reported = 0
        today_reported = 0
        by_route: dict[str, dict] = {}
        by_transport: dict[str, dict] = {}
        daily: dict[str, dict] = {}
        latest = None
        peak_request = None
        longest_request_ms = 0
        today = datetime.now().astimezone().date()
        for row in rows:
            usage = row.get("token_usage")
            if not isinstance(usage, dict):
                continue
            reported += 1
            latest = {"request_id": row.get("request_id"), "provider": row.get("actual_provider"),
                      "model_id": row.get("actual_model_id"), **usage}
            latest["updated_at"] = row.get("request_finished_at") or row.get("finished_at")
            key = f"{row.get('actual_provider') or 'unknown'}/{row.get('actual_model_id') or 'unknown'}"
            transport = str(row.get("route") or row.get("transport") or "unknown")
            bucket = by_route.setdefault(key, {"provider": row.get("actual_provider") or "unknown",
                                                "model_id": row.get("actual_model_id") or "unknown",
                                                "calls": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0})
            transport_bucket = by_transport.setdefault(transport, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0})
            bucket["calls"] += 1
            transport_bucket["calls"] += 1
            try:
                row_date = datetime.fromisoformat(str(row.get("request_finished_at") or row.get("finished_at")).replace("Z", "+00:00")).astimezone().date()
            except Exception:
                row_date = None
            if row_date == today:
                today_reported += 1
            if row_date:
                day = daily.setdefault(str(row_date), {"calls": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0})
                day["calls"] += 1
            for name in totals:
                amount = usage.get(name)
                if isinstance(amount, int):
                    totals[name] += amount
                    bucket[name] += amount
                    transport_bucket[name] += amount
                    if row_date == today:
                        today_totals[name] += amount
                    if row_date:
                        daily[str(row_date)][name] += amount
            total = int(usage.get("total_tokens") or 0)
            if peak_request is None or total > peak_request["total_tokens"]:
                peak_request = {"total_tokens": total, "request_id": row.get("request_id"), "updated_at": latest["updated_at"]}
            latency = int(row.get("total_latency_ms") or row.get("latency_ms") or 0)
            longest_request_ms = max(longest_request_ms, latency)
        active_dates = sorted(datetime.fromisoformat(x).date() for x in daily)
        longest_streak = current_streak = 0
        run = 0
        previous = None
        for active_date in active_dates:
            run = run + 1 if previous and (active_date - previous).days == 1 else 1
            longest_streak = max(longest_streak, run)
            previous = active_date
        if active_dates and (today - active_dates[-1]).days <= 1:
            current_streak = run
        return {"source": "provider_reported_only", "generated_at": _now(), "reported_calls": reported,
                "unreported_calls": max(0, len(rows) - reported), "totals": totals,
                "today": {"date": str(today), "reported_calls": today_reported, "totals": today_totals},
                "latest": latest, "by_route": by_route, "by_transport": by_transport,
                "activity": {"daily": daily, "peak_request": peak_request,
                             "longest_request_ms": longest_request_ms,
                             "current_streak_days": current_streak,
                             "longest_streak_days": longest_streak}}


store = AnalysisAuditStore()
