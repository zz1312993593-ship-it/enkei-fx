import tempfile
import unittest
from pathlib import Path

from app.analysis_audit import AnalysisAuditStore


class AnalysisAuditTests(unittest.TestCase):
    def test_usage_summary_counts_only_provider_reported_tokens(self):
        with tempfile.TemporaryDirectory() as folder:
            store = AnalysisAuditStore(Path(folder) / "traces.json")
            for request_id in ("reported", "missing"):
                store.submitted(request_id, {"symbol": "USDJPY", "timeframe": "M5"},
                                agent_id="", context={}, requested_provider="zhipu",
                                requested_model="glm-4.5-air", route="direct")
            store.finished("reported", status="succeeded",
                           result={"source": "zhipu", "model_id": "glm-4.5-air",
                                   "token_usage": {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}},
                           actual_provider="zhipu", actual_model_id="glm-4.5-air")
            store.finished("missing", status="succeeded",
                           result={"source": "zhipu", "model_id": "glm-4.5-air"},
                           actual_provider="zhipu", actual_model_id="glm-4.5-air")
            summary = store.usage_summary()
            self.assertEqual("provider_reported_only", summary["source"])
            self.assertEqual(1, summary["reported_calls"])
            self.assertEqual(1, summary["unreported_calls"])
            self.assertEqual(150, summary["totals"]["total_tokens"])
            self.assertEqual(1, summary["by_route"]["zhipu/glm-4.5-air"]["calls"])

    def test_validation_rejection_is_not_recorded_as_model_submission(self):
        with tempfile.TemporaryDirectory() as folder:
            store = AnalysisAuditStore(Path(folder) / "traces.json")
            store.submitted("req_validation", {"symbol": "USDJPY", "timeframe": "M5"},
                            agent_id="", context={"validation_errors": ["bars: history is stale"]},
                            route="validation", submitted_to_model=False)
            store.finished("req_validation", status="rejected", error="bars: history is stale")
            row = store.list()[0]
            self.assertFalse(row["submitted_to_model"])
            self.assertEqual("validation", row["route"])
            self.assertIsNone(row["model_response_started_at"])
            self.assertEqual("validation_rejected", row["timeline"][1]["stage"])

    def test_actual_route_and_fallback_are_not_mislabelled(self):
        with tempfile.TemporaryDirectory() as folder:
            store = AnalysisAuditStore(Path(folder) / "traces.json")
            summary = {"symbol": "USDJPY", "timeframe": "M5", "quote": {"mid": 153.2, "spread_pips": 1.1},
                       "bars": [{"time": "2026-09-10T00:00:00Z", "open": 153.1, "high": 153.3, "low": 153.0, "close": 153.2}],
                       "features": {"regime": "trend"}, "execution_context": {"selected_rule_model": "trend-breakout",
                       "positions": [{"side": "long", "lots": .01, "open_price": 153.0, "profit": 1.2, "account": 123}],
                       "previous_policy": {"policy_id": "policy_old", "action_bias": "long", "secret": "omit"}}}
            store.submitted("req_1", summary, agent_id="", context={},
                            requested_provider="zhipu", requested_model="glm-4.5-air", route="direct")
            store.attempt("req_1", provider="zhipu", model_id="glm-4.5-air", route="direct",
                          status="failed", error_type="timeout", error="request timed out")
            store.attempt("req_1", provider="ollama", model_id="gemma3:4b", route="local_ollama",
                          status="succeeded")
            store.finished("req_1", status="succeeded", result={"action_bias": "hold"},
                           actual_provider="ollama", actual_model_id="gemma3:4b",
                           route="local_ollama", degraded=True, degrade_reason="primary_route_failed",
                           local_fallback_used=True)
            row = store.list()[0]
            self.assertEqual("zhipu", row["requested_provider"])
            self.assertEqual("ollama", row["actual_provider"])
            self.assertEqual("gemma3:4b", row["effective_model_id"])
            self.assertTrue(row["local_fallback_used"])
            self.assertEqual(1, row["retry_count"])
            self.assertEqual(1.1, row["market_packet"]["quote"]["spread_pips"])
            self.assertEqual(153.2, row["market_packet"]["recent_bars"][0]["close"])
            self.assertEqual("trend-breakout", row["market_packet"]["execution_context"]["selected_rule_model"])
            self.assertNotIn("account", row["market_packet"]["execution_context"]["positions"][0])
            self.assertNotIn("secret", row["market_packet"]["execution_context"]["previous_policy"])
            self.assertNotIn("api_key", row)


if __name__ == "__main__":
    unittest.main()
