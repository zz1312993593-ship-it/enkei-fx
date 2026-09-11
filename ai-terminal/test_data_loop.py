"""Offline integration regressions. Fake packets stay in temporary stores."""
import asyncio
import copy
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app import research, scheduler, validator, schemas
from app.data_quality import market_errors, judgment_errors, report_errors
from app.providers import build_judge_prompt
from app.policy_store import PolicyStore
from app.deep_context import render_context


def packet(symbol="EURUSD", tf="M5"):
    now = datetime.now(timezone.utc)
    seconds = 300 if tf == "M5" else 900
    return {"version": "enkei-market-summary/v1", "generated_at": now.isoformat(), "symbol": symbol, "timeframe": tf,
            "quote": {"bid": 1.1, "ask": 1.1001, "spread_pips": 1, "received_at": now.isoformat()},
            "features": {"ema_fast": 1.1, "ema_slow": 1.09, "momentum": 0.1, "recent_high": 1.11, "recent_low": 1.08, "range_pips": 300},
            "bars": [{"time": (now - timedelta(seconds=seconds * (20-i))).isoformat(), "open": 1.1, "high": 1.11, "low": 1.08, "close": 1.1} for i in range(20)],
            "execution_context": {"selected_rule_model": "ema-cross", "positions": [], "previous_policy": None}}


JUDGMENT = {"market_regime": "range", "action_bias": "wait", "confidence": 60, "recommended_model": "ema-cross", "rationale_zh": "测试数据仅供离线验证"}
REPORT = {"headline": "离线测试研究", "thesis": {"short_bias": "wait", "mid_bias": "wait", "confidence": 60, "summary": "报价与均线存在分歧，等待确认"},
          "drivers": ["行情包"], "key_levels": [{"label": "支撑", "price": 1.08}], "risks": ["测试数据"], "next_checks": ["更新报价"], "source_assessment": "仅使用输入行情"}


class DataLoopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = PolicyStore(Path(self.tmp.name))
        with patch.object(research.ResearchService, "_load"), patch.object(research.ResearchService, "_save"):
            self.research = research.ResearchService()
        self.research._save = lambda: None
        self.research.configure(self.store)

    def test_packet_and_prompt(self):
        p = packet()
        self.assertEqual(market_errors(p), [])
        _, prompt = build_judge_prompt(p, "SOURCE_A\nRESEARCH_ID_123\nM15 evidence")
        for marker in ("EURUSD", "SOURCE_A", "RESEARCH_ID_123", "M15 evidence", "bid=1.1"):
            self.assertIn(marker, prompt)

    def test_stale_nonfinite_future_and_bad_bars(self):
        for mutate in (lambda p: p["quote"].update(bid=float("nan")), lambda p: p.update(generated_at="bad"),
                       lambda p: p["quote"].update(received_at=(datetime.now(timezone.utc)-timedelta(minutes=3)).isoformat()),
                       lambda p: p["bars"][-1].update(high=0), lambda p: p["bars"].reverse()):
            p = packet(); mutate(p)
            self.assertTrue(market_errors(p))

    def test_empty_or_bad_models_rejected(self):
        self.assertTrue(judgment_errors({}))
        self.assertTrue(report_errors({}))
        self.assertEqual(report_errors(REPORT), [])
        for value in (float("nan"), "60", True, 101):
            r = copy.deepcopy(REPORT); r["thesis"]["confidence"] = value
            self.assertTrue(report_errors(r))

    def test_policy_ttl_anchored_to_input(self):
        p = packet(); old = (datetime.now(timezone.utc)-timedelta(minutes=20)).isoformat()
        p["generated_at"] = old; p["quote"]["received_at"] = old
        policy = validator.build_policy(p, JUDGMENT, "librechat", "test", "test", request_id="test")
        self.store.put(policy)
        self.assertIsNone(self.store.get_current("EURUSD", "M5")[0])

    async def test_market_shared_before_model_success(self):
        s = scheduler.Scheduler(self.store, {})
        job = s.jobs.create("EURUSD", "M5")
        with patch.object(scheduler, "research_service", self.research), patch.object(scheduler.news_store, "relevant_items", AsyncMock(return_value=[])), patch.object(scheduler, "fetch_context", AsyncMock(return_value="")), patch.object(s, "_route_and_analyze", AsyncMock(side_effect=scheduler.providers_mod.ProviderError("offline"))):
            await s._process({"job_id": job, "summary": packet()})
        self.assertTrue(self.research.latest_packet("EURUSD", "M5"))
        self.assertEqual(s.jobs.get(job)["status"], "failed")

    async def test_report_to_prompt_to_validated_policy(self):
        await self.research.observe_market(packet())
        cfg = SimpleNamespace(agent_for=lambda tf: "offline", is_librechat_ready=lambda: True)
        with patch.object(research.gateway_mod, "load_gateway_config", return_value=cfg), patch.object(research.gateway_mod.LibreChatClient, "ask_agent", AsyncMock(return_value=copy.deepcopy(REPORT))), patch.object(research.news_store, "relevant_items", AsyncMock(return_value=[])):
            report = await self.research._generate({"symbol": "EURUSD", "language": "zh", "id": "test-topic", "name": "测试", "interval_minutes": 30}, "offline-test")
        self.assertEqual(report["status"], "evidence_ready")
        self.assertEqual("enkei-research-report/v2", report["version"])
        for field in ("data_status", "related_markets", "event_assessment", "evidence_balance",
                      "logic_consistency", "scenarios", "final_judgment", "change_from_previous",
                      "verified_facts", "inferences", "system_recommendations"):
            self.assertIn(field, report)
        received = []
        async def route(summary, tf, context, request_id):
            received.append(build_judge_prompt(summary, context)[1])
            return copy.deepcopy(JUDGMENT), "librechat", "offline", "none"
        s = scheduler.Scheduler(self.store, {})
        job = s.jobs.create("EURUSD", "M5")
        with patch.object(scheduler, "research_service", self.research), patch.object(scheduler.news_store, "relevant_items", AsyncMock(return_value=[])), patch.object(scheduler, "fetch_context", AsyncMock(return_value="DEEP_RESEARCH_REF")), patch.object(s, "_route_and_analyze", route):
            await s._process({"job_id": job, "summary": packet()})
        policy, _ = self.store.get_current("EURUSD", "M5")
        self.assertIsNotNone(policy)
        self.assertEqual(schemas.validate_output(policy), [])
        self.assertIn(report["id"], received[0]); self.assertIn("DEEP_RESEARCH_REF", received[0])
        self.assertIn(report["id"], " ".join(policy["news_context"]))
        self.assertEqual(schemas.validate_state(validator.build_state(policy)), [])

    async def test_empty_report_downgraded_and_old_cache_hidden(self):
        await self.research.observe_market(packet())
        cfg = SimpleNamespace(agent_for=lambda tf: "offline", is_librechat_ready=lambda: True)
        with patch.object(research.gateway_mod, "load_gateway_config", return_value=cfg), patch.object(research.gateway_mod.LibreChatClient, "ask_agent", AsyncMock(return_value={})), patch.object(research.news_store, "relevant_items", AsyncMock(return_value=[])):
            report = await self.research._generate({"symbol": "EURUSD", "language": "zh", "id": "test", "name": "测试", "interval_minutes": 30}, "offline")
        self.assertEqual(report["status"], "insufficient_sources")
        self.assertEqual("enkei-analysis-protocol/v2", report["protocol_version"])
        self.assertEqual("wait", report["final_judgment"]["action"])
        self.assertEqual(await self.research.context_for("EURUSD"), "")
        report["status"] = "evidence_ready"; report["thesis"] = {}
        self.research._reports = [report]
        self.assertEqual((await self.research.reports())[0]["status"], "insufficient_sources")

    async def test_unplanned_anomaly_is_persisted_and_requires_later_m5(self):
        topic = {"id": "topic-usdjpy", "symbol": "USDJPY", "name": "USDJPY", "language": "zh",
                 "enabled": True, "interval_minutes": 15, "last_run_at": None,
                 "last_observed_price": 153.0, "volatility_pips": 5, "events": []}
        self.research._topics = [topic]
        p = packet("USDJPY"); p["quote"].update(bid=153.1, ask=153.11)
        with patch.object(self.research, "run_topic", AsyncMock(return_value={"id": "r1", "status": "evidence_ready", "sources": []})):
            await self.research.observe_market(p)
            await asyncio.sleep(0)
        triggers = await self.research.triggers("USDJPY")
        self.assertEqual("unplanned_anomaly", triggers[0]["kind"])
        self.assertEqual("M5", triggers[0]["formal_decision_timeframe"])
        self.assertTrue(triggers[0]["normal_policy_suspended"])

    async def test_planned_event_uses_independent_trigger_type(self):
        recent = datetime.now(timezone.utc).isoformat()
        topic = {"id": "topic-usdjpy", "symbol": "USDJPY", "name": "USDJPY", "language": "zh",
                 "enabled": True, "interval_minutes": 15, "last_run_at": recent,
                 "last_observed_price": 153.0, "volatility_pips": 5,
                 "events": [{"name": "CPI", "at": recent, "before_minutes": 0, "after_minutes": 0, "impact": "high"}]}
        self.research._topics = [topic]
        with patch.object(self.research, "run_topic", AsyncMock(return_value={"id": "event-report", "status": "evidence_ready"})):
            await self.research._run_due()
        triggers = await self.research.triggers("USDJPY")
        self.assertEqual("planned_event", triggers[0]["kind"])
        self.assertEqual("event:CPI", triggers[0]["reason"])
        self.assertEqual("awaiting_m5", triggers[0]["status"])
        self.assertEqual("event-report", triggers[0]["report_id"])

    async def test_spread_widening_triggers_unplanned_overtime_analysis(self):
        self.research._topics = [{"id": "topic-usdjpy", "symbol": "USDJPY", "name": "USDJPY", "language": "zh",
            "enabled": True, "interval_minutes": 15, "last_run_at": None, "last_observed_price": 153.0,
            "last_observed_spread": 1.0, "last_observed_at": datetime.now(timezone.utc).isoformat(),
            "volatility_pips": 99, "events": []}]
        p = packet("USDJPY"); p["quote"].update(bid=153.0, ask=153.04, spread_pips=4.0)
        with patch.object(self.research, "run_topic", AsyncMock(return_value={"id": "spread-report", "status": "evidence_ready", "sources": []})):
            await self.research.observe_market(p); await asyncio.sleep(0)
        trigger = (await self.research.triggers("USDJPY"))[0]
        self.assertEqual("unplanned_anomaly", trigger["kind"])
        self.assertIn("spread-widening", trigger["reason"])

    async def test_data_recovery_gap_triggers_unplanned_overtime_analysis(self):
        self.research._topics = [{"id": "topic-usdjpy", "symbol": "USDJPY", "name": "USDJPY", "language": "zh",
            "enabled": True, "interval_minutes": 15, "last_run_at": None, "last_observed_price": 153.0,
            "last_observed_spread": 1.0, "last_observed_at": (datetime.now(timezone.utc)-timedelta(minutes=4)).isoformat(),
            "volatility_pips": 99, "events": []}]
        p = packet("USDJPY"); p["quote"].update(bid=153.0, ask=153.01, spread_pips=1.0)
        with patch.object(self.research, "run_topic", AsyncMock(return_value={"id": "recovery-report", "status": "evidence_ready", "sources": []})):
            await self.research.observe_market(p); await asyncio.sleep(0)
        trigger = (await self.research.triggers("USDJPY"))[0]
        self.assertIn("data-recovered-after", trigger["reason"])

    def test_deep_context_symbol_and_expiry(self):
        row = {"status": "ready", "symbol": "EURUSD", "timeframe": "M5", "expires_at": (datetime.now(timezone.utc)+timedelta(minutes=3)).isoformat(), "confidence": 60, "action_bias": "wait", "rationale": "test", "request_id": "123"}
        self.assertTrue(render_context(row, "EURUSD", "M5"))
        self.assertFalse(render_context(row, "USDJPY", "M5"))
        row["expires_at"] = "bad"
        self.assertFalse(render_context(row, "EURUSD", "M5"))


if __name__ == "__main__":
    unittest.main()
