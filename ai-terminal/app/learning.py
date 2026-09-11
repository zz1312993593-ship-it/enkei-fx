"""Persistent, auditable learning controls for Enkei.

The module never changes strategy weights from a single result.  It creates a
proposal from completed decision/outcome pairs; only an explicit confirmation
creates a new active version.  Every version is retained and can be rolled back.
"""
from __future__ import annotations

import gzip
import json
import shutil
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import config

MODELS = ("trend-breakout", "ema-cross", "trend-pullback", "range-reversion",
          "momentum-pulse", "session-breakout", "atr-channel", "asia-range")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class LearningCenter:
    def __init__(self, ledger):
        self.ledger = ledger
        self.path = config.LEDGER_DIR / "learning-control.json"
        self.archive_dir = config.LEDGER_DIR / "archives"
        self.backup_dir = config.LEDGER_DIR / "backups"
        self._lock = threading.RLock()
        self.state = self._load()

    def _default(self):
        initial = {m: 1.0 for m in MODELS}
        return {"schema": "enkei-learning/v2", "settings": {"mode": "record_only", "paused": False,
                "minimum_samples": 30, "minimum_strategy_samples": 8, "allow_confidence_adjustment": False,
                "minimum_condition_samples": 30, "max_single_delta": 0.10,
                "max_total_delta": 0.20, "candidate_min_outcomes": 20,
                "candidate_min_days": 7, "allow_confidence_adjustment": False,
                "allow_weight_adjustment": False, "allow_model_routing": False}, "active": {"version": 1,
                "weights": initial, "conditional_weights": {}, "status": "active",
                "applied_at": None, "reason": "初始等权；尚未使用学习结果调整策略。"},
                "versions": [], "proposal": None, "audit": []}

    def _load(self):
        if self.path.exists():
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    default = self._default()
                    return {**default, **value,
                            "settings": {**default["settings"], **value.get("settings", {})},
                            "active": {**default["active"], **value.get("active", {})}}
            except Exception: pass
        return self._default()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)

    def control(self):
        with self._lock:
            self._evaluate_candidate_locked()
            return {"settings": self.state["settings"], "active": self.state["active"],
                    "proposal": self.state.get("proposal"), "versions": self.state.get("versions", [])[-20:],
                    "audit": self.state.get("audit", [])[-50:]}

    def _joined(self):
        rows = self.ledger.query(limit=1_000_000)
        decisions = {r.get("policy_id"): r for r in rows if r.get("type") == "decision" and r.get("policy_id")}
        outcomes = [r for r in rows if r.get("type") == "outcome"]
        joined = []
        for out in outcomes:
            decision = decisions.get(out.get("policy_id"), {})
            entry, exit_ = float(out.get("entry_price") or 0), float(out.get("exit_price") or 0)
            direction = out.get("direction")
            direction_correct = (direction == "long" and exit_ > entry) or (direction == "short" and exit_ < entry)
            pnl = float(out.get("closed_pnl") or 0)
            item = {**decision, **out, "decision_received_at": decision.get("received_at"),
                    "direction_correct": direction_correct, "profitable": pnl > 0,
                    "strategy_model": decision.get("strategy_model") or decision.get("recommended_model") or "unknown",
                    "ai_model": decision.get("ai_model") or decision.get("model_id") or "unknown",
                    "ai_provider": decision.get("ai_provider") or decision.get("provider") or "unknown"}
            if direction_correct and pnl > 0: item["case_type"] = "judgment_and_execution_correct"
            elif direction_correct: item["case_type"] = "judgment_correct_timing_bad"
            elif decision.get("event_risk_invalidated"): item["case_type"] = "sudden_news_invalidated"
            elif pnl >= 0: item["case_type"] = "judgment_wrong_risk_controlled"
            else: item["case_type"] = "judgment_and_execution_wrong"
            joined.append(item)
        joined.sort(key=lambda x: x.get("closed_at") or x.get("received_at") or "", reverse=True)
        return rows, decisions, joined

    @staticmethod
    def _buckets(items, key):
        buckets = defaultdict(list)
        for item in items: buckets[str(item.get(key) or "unknown")].append(item)
        result = []
        for name, values in buckets.items():
            pnl = sum(float(v.get("closed_pnl") or 0) for v in values)
            correct = sum(bool(v.get("direction_correct")) for v in values)
            regimes = defaultdict(list)
            for value in values: regimes[str(value.get("market_regime") or "unknown")].append(value)
            regime_scores = sorted(((regime, sum(bool(x.get("direction_correct")) for x in rows) / len(rows))
                                    for regime, rows in regimes.items()), key=lambda x: x[1], reverse=True)
            result.append({"name": name, "samples": len(values), "direction_accuracy": round(correct / len(values), 3),
                           "net_pnl": round(pnl, 2), "avg_pnl": round(pnl / len(values), 2),
                           "strong_regime": regime_scores[0][0] if regime_scores else None,
                           "weak_regime": regime_scores[-1][0] if len(regime_scores) > 1 else None})
        return sorted(result, key=lambda x: (-x["samples"], x["name"]))

    @staticmethod
    def _session(item):
        explicit = item.get("session") or item.get("trading_session")
        if explicit:
            return str(explicit)
        raw = str(item.get("decision_received_at") or item.get("received_at") or "")
        try:
            hour = datetime.fromisoformat(raw.replace("Z", "+00:00")).hour
            if 0 <= hour < 7: return "asia"
            if 7 <= hour < 13: return "europe"
            if 13 <= hour < 21: return "us"
            return "transition"
        except Exception:
            return "unknown"

    @classmethod
    def _condition(cls, item):
        news = item.get("news_environment") or ("event" if item.get("event_risk_invalidated") else "normal")
        return {"symbol": str(item.get("symbol") or "unknown"),
                "timeframe": str(item.get("timeframe") or "unknown"),
                "market_regime": str(item.get("market_regime") or "unknown"),
                "session": cls._session(item), "news_environment": str(news)}

    @staticmethod
    def _risk_metrics(values):
        ordered = sorted(values, key=lambda x: x.get("closed_at") or x.get("received_at") or "")
        equity = peak = drawdown = 0.0
        losing = max_losing = 0
        for value in ordered:
            pnl = float(value.get("closed_pnl") or 0)
            equity += pnl; peak = max(peak, equity); drawdown = max(drawdown, peak - equity)
            losing = losing + 1 if pnl < 0 else 0; max_losing = max(max_losing, losing)
        spreads = [float(x.get("spread_pips") or x.get("spread") or x.get("spread_points") or 0) for x in values]
        slippages = [abs(float(x.get("slippage_pips") or x.get("slippage") or x.get("slippage_points") or 0)) for x in values]
        agreements = [x for x in values if x.get("ai_local_agreement") is not None]
        return {"max_drawdown": round(drawdown, 4), "max_consecutive_losses": max_losing,
                "avg_spread": round(sum(spreads) / len(spreads), 4) if spreads else None,
                "avg_abs_slippage": round(sum(slippages) / len(slippages), 4) if slippages else None,
                "ai_local_agreement_rate": round(sum(bool(x.get("ai_local_agreement")) for x in agreements) / len(agreements), 3) if agreements else None}

    @classmethod
    def _condition_stats(cls, items):
        groups = defaultdict(list)
        for item in items:
            condition = cls._condition(item)
            # Demo 与实盘遵循同一学习标准；来源仅用于审计和执行差异统计，
            # 不能把同一市场条件拆成两套权重或暗中降低 Demo 权重。
            condition_key = "|".join(condition[k] for k in ("symbol", "timeframe", "market_regime", "session", "news_environment"))
            groups[condition_key].append(item)
        result = []
        for condition_key, values in groups.items():
            strategies = cls._buckets(values, "strategy_model")
            pnl = sum(float(v.get("closed_pnl") or 0) for v in values)
            sources = sorted({str(v.get("environment") or v.get("account_mode") or v.get("execution_mode") or "unknown") for v in values})
            result.append({"condition_key": condition_key, "condition": {**cls._condition(values[0]), "sources": sources},
                           "samples": len(values), "net_pnl": round(pnl, 4),
                           "direction_accuracy": round(sum(bool(v.get("direction_correct")) for v in values) / len(values), 3),
                           "risk": cls._risk_metrics(values), "strategies": strategies})
        return sorted(result, key=lambda x: (-x["samples"], x["condition_key"]))

    def dashboard(self, limit=50, environment=None, lifecycle=None):
        rows, decisions, joined = self._joined()
        if environment and environment != "all":
            decisions = {key: value for key, value in decisions.items()
                         if str(value.get("environment") or value.get("account_mode") or value.get("execution_mode") or "unknown") == environment}
            joined = [value for value in joined if value.get("policy_id") in decisions]
        adopted = sum(r.get("adopted") is True for r in decisions.values())
        pnl = sum(float(r.get("closed_pnl") or 0) for r in joined)
        correct = sum(bool(r["direction_correct"]) for r in joined)
        cases = defaultdict(int)
        for row in joined: cases[row["case_type"]] += 1
        pending = [r for r in decisions.values() if not any(o.get("policy_id") == r.get("policy_id") for o in joined)]
        cases["insufficient_data_wait"] += sum(r.get("final_action") in (None, "wait") or not r.get("adopted") for r in pending)
        outcome_by_policy = {row.get("policy_id"): row for row in joined}
        timeline = []
        for decision in decisions.values():
            outcome = outcome_by_policy.get(decision.get("policy_id"))
            timeline.append({**decision, **(outcome or {}), "lifecycle": "completed" if outcome else
                            ("rejected" if decision.get("adopted") is not True else "awaiting_outcome")})
        timeline.sort(key=lambda x: x.get("decision_received_at") or x.get("received_at") or x.get("decision_generated_at") or "", reverse=True)
        if lifecycle and lifecycle != "all":
            timeline = [item for item in timeline if item.get("lifecycle") == lifecycle]
        size = self.ledger._path.stat().st_size if self.ledger._path.exists() else 0
        archives = list(self.archive_dir.glob("*.jsonl.gz")) if self.archive_dir.exists() else []
        backups = list(self.backup_dir.glob("events-*.jsonl")) if self.backup_dir.exists() else []
        today = datetime.now(timezone.utc).date().isoformat()
        today_rows = [row for row in rows if str(row.get("received_at") or "").startswith(today)]
        running, peak, max_drawdown = 0.0, 0.0, 0.0
        for row in reversed(joined):
            running += float(row.get("closed_pnl") or 0); peak = max(peak, running); max_drawdown = max(max_drawdown, peak - running)
        return {"generated_at": _now(), "filters": {"environment": environment or "all", "lifecycle": lifecycle or "all"},
                "overview": {"decisions": len(decisions), "adopted": adopted,
                "outcomes": len(joined), "direction_accuracy": round(correct / len(joined), 3) if joined else None,
                "net_pnl": round(pnl, 2), "avg_pnl": round(pnl / len(joined), 2) if joined else None,
                "max_drawdown": round(max_drawdown, 2), "sample_sufficient": len(joined) >= int(self.state["settings"]["minimum_samples"])},
                "timeline": timeline[:limit], "completed": joined[:limit], "cases": dict(cases),
                "models": self._buckets(joined, "ai_model"), "strategies": self._buckets(joined, "strategy_model"),
                "regimes": self._buckets(joined, "market_regime"),
                "conditions": self._condition_stats(joined), "control": self.control(),
                "storage": {"database_bytes": size, "hot_records": min(50, len(rows)),
                "warm_records": max(0, len(rows) - 50), "archives": len(archives),
                "archive_bytes": sum(p.stat().st_size for p in archives), "raw_records": len(rows),
                "today_records": len(today_rows), "backups": len(backups),
                "last_backup_at": datetime.fromtimestamp(max(p.stat().st_mtime for p in backups), timezone.utc).isoformat() if backups else None}}

    def propose(self):
        with self._lock:
            if not self.state["settings"].get("allow_weight_adjustment", False):
                raise ValueError("weight adjustment proposals are disabled")
            _, _, joined = self._joined()
            settings = self.state["settings"]
            minimum = int(settings["minimum_samples"])
            per_min = int(self.state["settings"]["minimum_strategy_samples"])
            condition_min = int(settings["minimum_condition_samples"])
            weights = dict(self.state["active"]["weights"])
            conditional = []
            for condition in self._condition_stats(joined):
                eligible = [x for x in condition["strategies"] if x["name"] in MODELS and x["samples"] >= per_min]
                if condition["samples"] < condition_min or len(eligible) < 2:
                    continue
                ranked = sorted(eligible, key=lambda x: (x["direction_accuracy"], x["avg_pnl"]), reverse=True)
                changes = {}
                total_delta = 0.0
                for stat in ranked:
                    current = float(self.state["active"].get("conditional_weights", {}).get(condition["condition_key"], {}).get(stat["name"], weights.get(stat["name"], 1.0)))
                    score = (stat["direction_accuracy"] - .5) * .16 + max(-.03, min(.03, stat["avg_pnl"] / 10000))
                    delta = max(-float(settings["max_single_delta"]), min(float(settings["max_single_delta"]), score))
                    remaining = max(0.0, float(settings["max_total_delta"]) - total_delta)
                    delta = max(-remaining, min(remaining, delta)); total_delta += abs(delta)
                    changes[stat["name"]] = {"old": round(current, 3), "delta": round(delta, 3),
                                             "new": round(max(.8, min(1.2, current + delta)), 3)}
                conditional.append({**condition, "changes": changes,
                                    "why": "同一市场条件下综合方向正确率、实际盈亏、回撤、连续亏损、点差、滑点及AI与本地策略一致性后生成。",
                                    "expected_improvement": "在该条件下提高风险调整后表现并降低错误策略占比。",
                                    "do_not_apply_when": ["样本条件发生变化", "重大新闻环境与样本不一致", "数据质量不足"],
                                    "rollback_to_version": self.state["active"].get("version", 1)})
            sufficient = len(joined) >= minimum and bool(conditional)
            proposal = {"id": f"lp_{uuid.uuid4().hex[:12]}", "created_at": _now(), "status": "awaiting_ai_review" if sufficient else "insufficient_samples",
                        "samples": len(joined), "required_samples": minimum, "required_condition_samples": condition_min,
                        "weights": weights, "conditional_proposals": conditional,
                        "constraints": {"max_single_delta": settings["max_single_delta"], "max_total_delta": settings["max_total_delta"],
                                        "candidate_min_outcomes": settings["candidate_min_outcomes"], "candidate_min_days": settings["candidate_min_days"]},
                        "reason": "系统证据门槛已通过，等待统一分析体提出可解释建议；AI建议仍须经过幅度限制和用户确认。" if sufficient else f"现有 {len(joined)} 个闭环样本，尚无同时达到 {condition_min} 个同条件样本且至少两个策略各 {per_min} 个样本的可比证据。",
                        "ai_review": None}
            self.state["proposal"] = proposal
            self.state["audit"].append({"time": _now(), "action": "proposal_created", "proposal_id": proposal["id"], "status": proposal["status"]})
            self._save(); return proposal

    def apply_ai_review(self, proposal_id, review, identity):
        """Validate and clamp an AI suggestion; the model can advise but never bypass policy controls."""
        with self._lock:
            proposal = self.state.get("proposal")
            if not proposal or proposal.get("id") != proposal_id:
                raise ValueError("proposal not found")
            if proposal.get("status") != "awaiting_ai_review":
                raise ValueError("proposal is not awaiting AI review")
            if not isinstance(review, dict) or not isinstance(review.get("recommendations"), list):
                raise ValueError("AI review is missing recommendations")
            source = {item["condition_key"]: item for item in proposal.get("conditional_proposals", [])}
            accepted = []
            max_single = float(self.state["settings"]["max_single_delta"])
            max_total = float(self.state["settings"]["max_total_delta"])
            for advice in review["recommendations"]:
                if not isinstance(advice, dict) or str(advice.get("condition_key") or "") not in source:
                    continue
                evidence = source[str(advice["condition_key"])]
                requested = advice.get("changes") if isinstance(advice.get("changes"), dict) else {}
                total = 0.0; changes = {}
                for strategy, base in evidence["changes"].items():
                    raw = requested.get(strategy)
                    raw_delta = raw.get("delta") if isinstance(raw, dict) else raw
                    try: delta = float(raw_delta)
                    except (TypeError, ValueError): delta = float(base["delta"])
                    delta = max(-max_single, min(max_single, delta))
                    remaining = max(0.0, max_total - total)
                    delta = max(-remaining, min(remaining, delta)); total += abs(delta)
                    changes[strategy] = {"old": base["old"], "delta": round(delta, 3),
                                         "new": round(max(.8, min(1.2, float(base["old"]) + delta)), 3)}
                accepted.append({**evidence, "changes": changes,
                    "why": str(advice.get("why") or evidence["why"])[:1200],
                    "expected_improvement": str(advice.get("expected_improvement") or evidence["expected_improvement"])[:800],
                    "do_not_apply_when": [
                        str(x)[:240]
                        for x in (
                            advice.get("do_not_apply_when")
                            if isinstance(advice.get("do_not_apply_when"), list)
                            else evidence["do_not_apply_when"]
                        )
                        if isinstance(x, (str, int, float))
                    ][:8],
                    "confidence": max(0, min(100, float(advice.get("confidence") or 0))),
                    "sample_reliability": str(advice.get("sample_reliability") or "unknown")[:120],
                    "ai_evidence_summary": str(advice.get("evidence_summary") or "")[:1200]})
            if not accepted:
                raise ValueError("AI review did not reference any eligible condition")
            proposal["conditional_proposals"] = accepted
            proposal["status"] = "pending"
            proposal["ai_review"] = {"status": "completed", "completed_at": _now(), **dict(identity),
                                     "summary": str(review.get("summary") or "")[:1600],
                                     "risks": [str(x)[:240] for x in review.get("risks", []) if isinstance(x, (str, int, float))][:8]}
            proposal["reason"] = "统一分析体已基于闭环证据生成建议；系统已执行样本门槛、策略范围与调整幅度复核，等待用户确认。"
            self.state["audit"].append({"time": _now(), "action": "ai_review_completed", "proposal_id": proposal_id,
                                        "request_id": identity.get("request_id"), "provider": identity.get("provider"),
                                        "model_id": identity.get("model_id"), "accepted_conditions": len(accepted)})
            self._save(); return proposal

    def fail_ai_review(self, proposal_id, error, identity=None):
        with self._lock:
            proposal = self.state.get("proposal")
            if not proposal or proposal.get("id") != proposal_id:
                raise ValueError("proposal not found")
            proposal["status"] = "ai_review_failed"
            proposal["ai_review"] = {"status": "failed", "completed_at": _now(),
                                     "error": str(error)[:600], **(identity or {})}
            self.state["audit"].append({"time": _now(), "action": "ai_review_failed", "proposal_id": proposal_id,
                                        "error": str(error)[:240]})
            self._save(); return proposal

    def confirm(self, proposal_id, confirmation):
        with self._lock:
            p = self.state.get("proposal")
            if confirmation != "APPLY": raise ValueError("confirmation must be APPLY")
            if not p or p.get("id") != proposal_id: raise ValueError("proposal not found")
            if p.get("status") != "pending": raise ValueError("proposal is not eligible")
            previous = dict(self.state["active"])
            self.state["versions"].append(previous)
            version = int(previous.get("version", 1)) + 1
            conditional_weights = dict(previous.get("conditional_weights", {}))
            for condition in p.get("conditional_proposals", []):
                conditional_weights[condition["condition_key"]] = {name: change["new"] for name, change in condition["changes"].items()}
            self.state["active"] = {"version": version, "weights": p["weights"],
                                    "conditional_weights": conditional_weights, "status": "candidate",
                                    "candidate_started_at": _now(), "candidate_baseline_outcomes": p.get("samples", 0),
                                    "candidate_baseline": [{"condition_key": item["condition_key"],
                                                            "samples": item["samples"], "net_pnl": item["net_pnl"],
                                                            "direction_accuracy": item["direction_accuracy"], "risk": item["risk"]}
                                                           for item in p.get("conditional_proposals", [])],
                                    "applied_at": _now(), "reason": p["reason"], "proposal_id": proposal_id}
            self.state["settings"]["mode"] = "cautious"
            p["status"] = "candidate"; p["applied_at"] = _now()
            self.state["audit"].append({"time": _now(), "action": "candidate_created", "version": version, "proposal_id": proposal_id})
            self._save(); return self.control()

    def _evaluate_candidate_locked(self):
        active = self.state.get("active", {})
        if active.get("status") != "candidate":
            return active.get("candidate_evaluation")
        _, _, joined = self._joined()
        baseline_count = int(active.get("candidate_baseline_outcomes", 0))
        new_items = joined[:max(0, len(joined) - baseline_count)]
        risk = self._risk_metrics(new_items)
        started = datetime.fromisoformat(str(active.get("candidate_started_at") or _now()).replace("Z", "+00:00"))
        elapsed_days = max(0.0, (datetime.now(timezone.utc) - started).total_seconds() / 86400)
        baselines = active.get("candidate_baseline", [])
        baseline_drawdown = max((float(x.get("risk", {}).get("max_drawdown") or 0) for x in baselines), default=0)
        baseline_losses = max((int(x.get("risk", {}).get("max_consecutive_losses") or 0) for x in baselines), default=0)
        drawdown_breach = bool(new_items) and risk["max_drawdown"] > max(baseline_drawdown * 1.2, baseline_drawdown + 1e-9)
        loss_breach = bool(new_items) and risk["max_consecutive_losses"] > baseline_losses + 2
        ready = len(new_items) >= int(self.state["settings"]["candidate_min_outcomes"]) and elapsed_days >= int(self.state["settings"]["candidate_min_days"])
        evaluation = {"new_outcomes": len(new_items), "elapsed_days": round(elapsed_days, 2),
                      "required_outcomes": self.state["settings"]["candidate_min_outcomes"],
                      "required_days": self.state["settings"]["candidate_min_days"],
                      "risk": risk, "baseline_max_drawdown": baseline_drawdown,
                      "baseline_max_consecutive_losses": baseline_losses,
                      "ready_for_activation": ready and not drawdown_breach and not loss_breach,
                      "automatic_pause_reason": "drawdown_worsened" if drawdown_breach else ("consecutive_losses" if loss_breach else None)}
        active["candidate_evaluation"] = evaluation
        if evaluation["automatic_pause_reason"]:
            active["status"] = "candidate_paused"
            active["paused_at"] = _now()
            self.state["audit"].append({"time": _now(), "action": "candidate_auto_paused",
                                        "version": active.get("version"), "reason": evaluation["automatic_pause_reason"]})
            self._save()
        return evaluation

    def activate(self, confirmation):
        with self._lock:
            if confirmation != "ACTIVATE": raise ValueError("confirmation must be ACTIVATE")
            active = self.state.get("active", {})
            if active.get("status") != "candidate": raise ValueError("no active candidate")
            evaluation = self._evaluate_candidate_locked() or {}
            if not evaluation.get("ready_for_activation"): raise ValueError("candidate observation gate not met")
            active["status"] = "active"; active["activated_at"] = _now()
            self.state["audit"].append({"time": _now(), "action": "candidate_activated", "version": active.get("version")})
            self._save(); return self.control()

    def rollback(self, confirmation):
        with self._lock:
            if confirmation != "ROLLBACK": raise ValueError("confirmation must be ROLLBACK")
            versions = self.state.get("versions", [])
            if not versions: raise ValueError("no previous version")
            current, target = dict(self.state["active"]), versions.pop()
            target = {**target, "rolled_back_at": _now(), "rollback_from": current.get("version")}
            self.state["active"] = target
            self.state["audit"].append({"time": _now(), "action": "rollback", "from": current.get("version"), "to": target.get("version")})
            self._save(); return self.control()

    def settings(self, payload):
        with self._lock:
            settings = self.state["settings"]
            if "paused" in payload: settings["paused"] = bool(payload["paused"])
            if payload.get("mode") in ("record_only", "cautious"): settings["mode"] = payload["mode"]
            for key in ("allow_confidence_adjustment", "allow_weight_adjustment", "allow_model_routing"):
                if key in payload: settings[key] = bool(payload[key])
            for key, low, high in (("minimum_samples", 20, 1000), ("minimum_strategy_samples", 5, 500),
                                   ("minimum_condition_samples", 20, 1000), ("candidate_min_outcomes", 10, 1000),
                                   ("candidate_min_days", 1, 90)):
                if key in payload: settings[key] = max(low, min(high, int(payload[key])))
            for key, low, high in (("max_single_delta", .01, .10), ("max_total_delta", .02, .20)):
                if key in payload: settings[key] = max(low, min(high, float(payload[key])))
            self.state["audit"].append({"time": _now(), "action": "settings_updated", "settings": dict(settings)})
            self._save(); return self.control()

    def export(self):
        return {"schema": "enkei-learning-export/v1", "exported_at": _now(),
                "events": self.ledger.query(limit=1_000_000), "control": self.control()}

    def cleanup(self, confirmation):
        if confirmation != "CLEANUP": raise ValueError("confirmation must be CLEANUP")
        with self._lock:
            self.archive_dir.mkdir(parents=True, exist_ok=True)
            archives = sorted(self.archive_dir.glob("events-*.jsonl.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
            removed = []
            for path in archives[5:]:
                removed.append(path.name); path.unlink(missing_ok=True)
                manifest = path.with_name(path.name.replace(".jsonl.gz", ".manifest.json")); manifest.unlink(missing_ok=True)
            self.state["audit"].append({"time": _now(), "action": "archive_cleanup", "removed": removed})
            self._save(); return {"removed": removed, "retained": min(5, len(archives)),
                                  "note": "仅清理旧冷归档；原始判断、成交和最近五份归档均保留。"}

    def restore_latest(self, confirmation):
        if confirmation != "RESTORE": raise ValueError("confirmation must be RESTORE")
        with self._lock:
            backups = sorted(self.backup_dir.glob("events-*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not backups: raise ValueError("no backup available")
            safety = self.backup_dir / f"events-before-restore-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
            if self.ledger._path.exists(): shutil.copy2(self.ledger._path, safety)
            shutil.copy2(backups[0], self.ledger._path); self.ledger.reload()
            self.state["audit"].append({"time": _now(), "action": "ledger_restored", "source": backups[0].name,
                                        "safety_backup": safety.name})
            self._save(); return {"restored_from": backups[0].name, "records": self.ledger.count(), "safety_backup": safety.name}

    def archive(self):
        with self._lock:
            self.archive_dir.mkdir(parents=True, exist_ok=True); self.backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = self.backup_dir / f"events-{stamp}.jsonl"
            if self.ledger._path.exists(): shutil.copy2(self.ledger._path, backup)
            archive = self.archive_dir / f"events-{stamp}.jsonl.gz"
            with gzip.open(archive, "wb") as target:
                if self.ledger._path.exists(): target.write(self.ledger._path.read_bytes())
            manifest = {"created_at": _now(), "raw_records": self.ledger.count(), "archive": archive.name,
                        "backup": backup.name, "note": "非破坏性压缩归档；原始台账未删除。"}
            (self.archive_dir / f"events-{stamp}.manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            self.state["audit"].append({"time": _now(), "action": "archive_created", **manifest})
            self._save(); return manifest
