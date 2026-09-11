import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app.evaluator import LedgerStore
from app.learning import LearningCenter


class LearningCenterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.ledger = LedgerStore(root / "events.jsonl")
        self.config_patch = patch("app.learning.config.LEDGER_DIR", root)
        self.config_patch.start()
        self.center = LearningCenter(self.ledger)

    def tearDown(self):
        self.config_patch.stop()
        self.temp.cleanup()

    def add_closed_loop(self, index, strategy, correct=True):
        direction = "long"
        self.ledger.add_decision({"event_id": f"d{index}", "type": "decision", "policy_id": f"p{index}",
            "symbol": "USDJPY", "timeframe": "M5", "adopted": True, "final_action": direction,
            "strategy_model": strategy, "ai_model": "glm-4.5-air", "market_regime": "trend",
            "environment": "demo", "session": "us", "news_environment": "normal",
            "ai_local_agreement": strategy == "trend-breakout"})
        self.ledger.add_outcome({"event_id": f"o{index}", "type": "outcome", "policy_id": f"p{index}",
            "symbol": "USDJPY", "timeframe": "M5", "direction": direction, "entry_price": 150,
            "exit_price": 151 if correct else 149, "closed_pnl": 100 if correct else -100})

    def ai_review(self, proposal):
        return {"summary": "同条件闭环证据支持有限幅度调整。", "risks": ["样本外环境可能失效"], "recommendations": [
            {"condition_key": item["condition_key"], "changes": {name: change["delta"] for name, change in item["changes"].items()},
             "why": "综合方向正确率、盈亏、回撤和一致性。", "expected_improvement": "降低同条件错误策略占比。",
             "do_not_apply_when": ["新闻环境变化"], "confidence": 72, "sample_reliability": "medium",
             "evidence_summary": "样本与风险指标已经达到系统门槛。"}
            for item in proposal["conditional_proposals"]]}

    def reviewed_proposal(self):
        proposal = self.center.propose()
        if proposal["status"] == "awaiting_ai_review":
            proposal = self.center.apply_ai_review(proposal["id"], self.ai_review(proposal),
                {"request_id": "learn-test", "provider": "zhipu", "model_id": "glm-test", "route": "provider_direct"})
        return proposal

    def test_unconfirmed_proposal_never_changes_active_weights(self):
        self.center.settings({"allow_weight_adjustment": True})
        for i in range(16): self.add_closed_loop(i, "trend-breakout", True)
        for i in range(16, 32): self.add_closed_loop(i, "ema-cross", False)
        before = dict(self.center.control()["active"]["weights"])
        proposal = self.reviewed_proposal()
        self.assertEqual("pending", proposal["status"])
        self.assertEqual(before, self.center.control()["active"]["weights"])

    def test_confirm_and_rollback_are_versioned(self):
        self.center.settings({"allow_weight_adjustment": True})
        for i in range(16): self.add_closed_loop(i, "trend-breakout", True)
        for i in range(16, 32): self.add_closed_loop(i, "ema-cross", False)
        proposal = self.reviewed_proposal()
        applied = self.center.confirm(proposal["id"], "APPLY")
        self.assertEqual(2, applied["active"]["version"])
        self.assertEqual("candidate", applied["active"]["status"])
        condition_weights = next(iter(applied["active"]["conditional_weights"].values()))
        self.assertGreater(condition_weights["trend-breakout"], condition_weights["ema-cross"])
        rolled = self.center.rollback("ROLLBACK")
        self.assertEqual(1, rolled["active"]["version"])
        self.assertTrue(all(value == 1 for value in rolled["active"]["weights"].values()))

    def test_proposal_contains_full_condition_and_risk_evidence(self):
        self.center.settings({"allow_weight_adjustment": True})
        for i in range(16): self.add_closed_loop(i, "trend-breakout", True)
        for i in range(16, 32): self.add_closed_loop(i, "ema-cross", False)
        proposal = self.reviewed_proposal()
        evidence = proposal["conditional_proposals"][0]
        self.assertEqual("USDJPY", evidence["condition"]["symbol"])
        self.assertEqual("M5", evidence["condition"]["timeframe"])
        self.assertEqual(["demo"], evidence["condition"]["sources"])
        self.assertIn("max_drawdown", evidence["risk"])
        self.assertIn("max_consecutive_losses", evidence["risk"])
        self.assertLessEqual(sum(abs(x["delta"]) for x in evidence["changes"].values()), .201)

    def test_insufficient_samples_cannot_apply(self):
        self.center.settings({"allow_weight_adjustment": True})
        self.add_closed_loop(1, "trend-breakout", True)
        proposal = self.center.propose()
        self.assertEqual("insufficient_samples", proposal["status"])
        with self.assertRaises(ValueError): self.center.confirm(proposal["id"], "APPLY")

    def test_weight_proposal_requires_explicit_permission(self):
        with self.assertRaises(ValueError):
            self.center.propose()

    def test_ai_review_is_required_and_cannot_bypass_delta_limits(self):
        self.center.settings({"allow_weight_adjustment": True})
        for i in range(16): self.add_closed_loop(i, "trend-breakout", True)
        for i in range(16, 32): self.add_closed_loop(i, "ema-cross", False)
        proposal = self.center.propose()
        self.assertEqual("awaiting_ai_review", proposal["status"])
        with self.assertRaises(ValueError): self.center.confirm(proposal["id"], "APPLY")
        review = self.ai_review(proposal)
        for item in review["recommendations"]:
            item["changes"] = {name: 999 for name in item["changes"]}
        reviewed = self.center.apply_ai_review(proposal["id"], review,
            {"request_id": "learn-clamp", "provider": "zhipu", "model_id": "glm-test"})
        self.assertEqual("pending", reviewed["status"])
        for item in reviewed["conditional_proposals"]:
            self.assertLessEqual(sum(abs(change["delta"]) for change in item["changes"].values()), .201)

    def test_demo_and_live_share_metrics_but_remain_filterable(self):
        self.add_closed_loop(1, "trend-breakout", True)
        self.ledger.add_decision({"event_id": "d-live", "type": "decision", "policy_id": "p-live",
            "symbol": "USDJPY", "timeframe": "M5", "adopted": True, "final_action": "long",
            "strategy_model": "trend-breakout", "ai_model": "glm-4.5-air", "market_regime": "trend",
            "environment": "live", "session": "us", "news_environment": "normal"})
        self.ledger.add_outcome({"event_id": "o-live", "type": "outcome", "policy_id": "p-live",
            "symbol": "USDJPY", "timeframe": "M5", "direction": "long", "entry_price": 150,
            "exit_price": 151, "closed_pnl": 50})
        self.assertEqual(2, self.center.dashboard()["overview"]["outcomes"])
        self.assertEqual(1, self.center.dashboard(environment="demo")["overview"]["outcomes"])
        self.assertEqual(1, self.center.dashboard(environment="live")["overview"]["outcomes"])
        conditions = self.center.dashboard()["conditions"]
        self.assertEqual(1, len(conditions))
        self.assertEqual(["demo", "live"], conditions[0]["condition"]["sources"])

    def test_real_execution_cost_fields_feed_condition_risk_metrics(self):
        self.ledger.add_decision({"event_id": "d-cost", "type": "decision", "policy_id": "p-cost",
            "symbol": "USDJPY", "timeframe": "M5", "adopted": True, "final_action": "long",
            "strategy_model": "trend-breakout", "ai_model": "glm-4.5-air", "market_regime": "trend", "environment": "live"})
        self.ledger.add_outcome({"event_id": "o-cost", "type": "outcome", "policy_id": "p-cost", "symbol": "USDJPY",
            "timeframe": "M5", "direction": "long", "entry_price": 150, "exit_price": 151, "closed_pnl": 20,
            "spread_pips": 1.2, "slippage_pips": 0.4, "environment": "live"})
        risk = self.center.dashboard()["conditions"][0]["risk"]
        self.assertEqual(1.2, risk["avg_spread"])
        self.assertEqual(0.4, risk["avg_abs_slippage"])

    def test_candidate_requires_observation_then_explicit_activation(self):
        self.center.settings({"allow_weight_adjustment": True})
        for i in range(16): self.add_closed_loop(i, "trend-breakout", True)
        for i in range(16, 32): self.add_closed_loop(i, "ema-cross", False)
        proposal = self.reviewed_proposal(); self.center.confirm(proposal["id"], "APPLY")
        with self.assertRaises(ValueError): self.center.activate("ACTIVATE")
        self.center.state["active"]["candidate_started_at"] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        for i in range(32, 52): self.add_closed_loop(i, "trend-breakout", True)
        activated = self.center.activate("ACTIVATE")
        self.assertEqual("active", activated["active"]["status"])


if __name__ == "__main__":
    unittest.main()
