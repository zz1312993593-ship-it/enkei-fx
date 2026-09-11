"""圆衡 Enkei 外部 AI 终端 - 评估回环台账（evaluator）

v1.4.0 评估回环：
- 主程序侧将 decision-event / outcome-event POST 到此模块记账（AI 终端为权威单一来源）；
- 按 event_id 幂等：同 ID 重复投递不重复记账；
- JSONL 落盘 data/ledger/events.jsonl，线程安全；
- 提供明细查询与 evaluation-summary 统计（前端只读）。
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import config

# 事件类型与必填字段
DECISION_REQUIRED = {"event_id", "type", "policy_id", "symbol", "timeframe", "adopted"}
OUTCOME_REQUIRED = {"event_id", "type", "policy_id", "symbol", "timeframe", "direction",
                    "entry_price", "exit_price", "closed_pnl"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


class LedgerError(Exception):
    """台账数据校验失败。"""


class LedgerStore:
    """决策/结果事件台账：内存索引 + JSONL 落盘，按 event_id 幂等。"""

    def __init__(self, path: Path | None = None):
        self._path = path or (config.LEDGER_DIR / "events.jsonl")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._rows: list[dict] = []
        self._ids: set[str] = set()
        self._load()

    def _load(self):
        if not self._path.exists():
            return
        for line in self._path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if not isinstance(row, dict):
                continue
            self._rows.append(row)
            eid = row.get("event_id")
            if eid:
                self._ids.add(eid)

    # ---------- 写入 ----------
    def _validate(self, event: dict) -> None:
        etype = event.get("type")
        required = DECISION_REQUIRED if etype == "decision" else (OUTCOME_REQUIRED if etype == "outcome" else None)
        if required is None:
            raise LedgerError("type 必须为 decision 或 outcome")
        missing = required - set(event.keys())
        if missing:
            raise LedgerError(f"缺少必填字段: {sorted(missing)}")
        if not event.get("event_id"):
            raise LedgerError("event_id 必填且非空")

    def add(self, event: dict) -> dict:
        """写入事件。返回 {"status": "recorded"|"duplicate", "event_id": ...}。"""
        if not isinstance(event, dict):
            raise LedgerError("事件必须是 JSON 对象")
        self._validate(event)
        event_id = event["event_id"]
        received_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        row = dict(event)
        row["received_at"] = received_at
        with self._lock:
            if event_id in self._ids:
                return {"status": "duplicate", "event_id": event_id}
            self._rows.append(row)
            self._ids.add(event_id)
            with open(self._path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            return {"status": "recorded", "event_id": event_id}

    def add_decision(self, event: dict) -> dict:
        e = dict(event)
        e["type"] = "decision"
        return self.add(e)

    def add_outcome(self, event: dict) -> dict:
        e = dict(event)
        e["type"] = "outcome"
        return self.add(e)

    # ---------- 查询 ----------
    def query(self, symbol: str | None = None, timeframe: str | None = None,
              event_type: str | None = None, limit: int = 200) -> list[dict]:
        with self._lock:
            rows = list(self._rows)
        rows.sort(key=lambda r: r.get("received_at", ""), reverse=True)
        out = []
        for r in rows:
            if symbol and r.get("symbol") != symbol:
                continue
            if timeframe and r.get("timeframe") != timeframe:
                continue
            if event_type and r.get("type") != event_type:
                continue
            out.append(r)
            if len(out) >= limit:
                break
        return out

    def count(self) -> int:
        with self._lock:
            return len(self._rows)

    def reload(self) -> None:
        """Reload a verified restored ledger without restarting the terminal."""
        with self._lock:
            self._rows = []
            self._ids = set()
            self._load()

    # ---------- 统计 ----------
    def summary(self) -> dict:
        with self._lock:
            decisions = [r for r in self._rows if r.get("type") == "decision"]
            outcomes = [r for r in self._rows if r.get("type") == "outcome"]

        adopted = [r for r in decisions if r.get("adopted") is True]
        rejected = [r for r in decisions if r.get("adopted") is not True]

        def _pnl(r: dict) -> float:
            try:
                v = float(r.get("closed_pnl") or 0)
                if v == 0:
                    v = float(r.get("floating_pnl") or 0)
                return v
            except (TypeError, ValueError):
                return 0.0

        wins = [r for r in outcomes if _pnl(r) > 0]
        losses = [r for r in outcomes if _pnl(r) < 0]

        durations = []
        for r in outcomes:
            d = r.get("duration_seconds")
            try:
                durations.append(float(d))
            except (TypeError, ValueError):
                continue
        avg_duration = round(sum(durations) / len(durations), 1) if durations else 0.0

        # 按模型分桶（decision 关联 policy_id → 需从决策事件取 model_id，允许缺失）
        by_model: dict[str, dict] = {}
        for r in decisions:
            m = r.get("ai_model") or r.get("model_id") or "unknown"
            b = by_model.setdefault(m, {"model_id": m, "decisions": 0, "adopted": 0, "rejected": 0,
                                        "wins": 0, "losses": 0, "win_rate": 0.0})
            b["decisions"] += 1
            if r.get("adopted") is True:
                b["adopted"] += 1
            else:
                b["rejected"] += 1
        # 结果按 policy_id 关联到模型（outcome 本身可能不带 model_id）
        policy_to_model: dict[str, str] = {}
        for r in decisions:
            pid = r.get("policy_id")
            if pid:
                policy_to_model.setdefault(pid, r.get("ai_model") or r.get("model_id") or "unknown")
        for r in outcomes:
            pid = r.get("policy_id")
            m = policy_to_model.get(pid, r.get("ai_model") or r.get("model_id") or "unknown")
            b = by_model.setdefault(m, {"model_id": m, "decisions": 0, "adopted": 0, "rejected": 0,
                                        "wins": 0, "losses": 0, "win_rate": 0.0})
            if _pnl(r) > 0:
                b["wins"] += 1
            elif _pnl(r) < 0:
                b["losses"] += 1
        for b in by_model.values():
            judged = b["wins"] + b["losses"]
            b["win_rate"] = round(b["wins"] / judged, 3) if judged else 0.0
        by_model_list = sorted(by_model.values(), key=lambda b: b["decisions"], reverse=True)

        # 按 action_bias 分桶（policy_id → bias 映射，从 decision 事件取）
        pid_to_bias: dict[str, str] = {}
        for r in decisions:
            pid = r.get("policy_id")
            if pid:
                pid_to_bias.setdefault(pid, r.get("final_action") or r.get("action_bias") or "unknown")
        by_bias: dict[str, dict] = {}
        for r in decisions:
            pid = r.get("policy_id")
            bias = pid_to_bias.get(pid, r.get("final_action") or r.get("action_bias") or "unknown")
            b = by_bias.setdefault(bias, {"action_bias": bias, "count": 0, "win_rate": 0.0})
            b["count"] += 1
        for r in outcomes:
            pid = r.get("policy_id")
            bias = pid_to_bias.get(pid, r.get("direction") or "unknown")
            b = by_bias.setdefault(bias, {"action_bias": bias, "count": 0, "win_rate": 0.0})
            b.setdefault("wins", 0)
            b.setdefault("losses", 0)
            if _pnl(r) > 0:
                b["wins"] = b.get("wins", 0) + 1
            elif _pnl(r) < 0:
                b["losses"] = b.get("losses", 0) + 1
        for b in by_bias.values():
            wins_count = b.get("wins", 0)
            losses_count = b.get("losses", 0)
            judged = wins_count + losses_count
            b["win_rate"] = round(wins_count / judged, 3) if judged else 0.0
            b.pop("wins", None)
            b.pop("losses", None)
        by_bias_list = sorted(by_bias.values(), key=lambda b: b["count"], reverse=True)

        n_dec = len(decisions)
        n_out = len(outcomes)
        return {
            "version": "enkei-evaluation-summary/v1",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "totals": {
                "decisions": n_dec,
                "adopted": len(adopted),
                "rejected": len(rejected),
                "outcomes": n_out,
                "wins": len(wins),
                "losses": len(losses),
            },
            "rates": {
                "adoption_rate": round(len(adopted) / n_dec, 3) if n_dec else 0.0,
                "win_rate": round(len(wins) / n_out, 3) if n_out else 0.0,
                "avg_duration_seconds": avg_duration,
            },
            "by_model": by_model_list,
            "by_bias": by_bias_list,
        }
