"""Offline regressions for the delivery review; no model or broker calls."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone, timedelta

from enkei_adapter import EnkeiMarketAdapter
from ta_runner import run_analysis


class DeliveryReviewTests(unittest.TestCase):
    def test_quote_matches_symbol_and_rejects_stale(self):
        snapshot = {"age_ms": 20, "clock_status": "aligned", "quotes": [
            {"symbol": "USDJPY", "bid": 150, "ask": 150.01},
            {"symbol": "EURUSD", "bid": 1.1, "ask": 1.1001}]}
        with patch('enkei_adapter._http_get_json', return_value=snapshot):
            adapter = EnkeiMarketAdapter()
            self.assertEqual(adapter.fetch_snapshot_quote('EURUSD')['bid'], 1.1)
            self.assertIsNone(adapter.fetch_snapshot_quote('GBPUSD'))
            snapshot['age_ms'] = 11000
            self.assertIsNone(adapter.fetch_snapshot_quote('EURUSD'))

    def test_atr_uses_all_fourteen_pairs(self):
        bars = [{"time": i, "open": 100, "close": 100, "high": 101,
                 "low": 99, "_symbol": "USDJPY"} for i in range(15)]
        self.assertEqual(EnkeiMarketAdapter()._compute_features(bars)['atr_pips'], 200)

    def test_unknown_clock_and_old_history_are_not_ready(self):
        adapter = EnkeiMarketAdapter()
        self.assertEqual(adapter._freshness({'file_age_ms': 1, 'clock': {}})['level'], 'stale')
        self.assertEqual(adapter._freshness({'file_age_ms': 1000000, 'clock': {'status': 'aligned'}})['level'], 'stale')

    def test_slow_analysis_does_not_renew_expired_data(self):
        fetched = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        snapshot = {'generated_at': fetched, 'features': {}, 'market_data': {
            'source': 'test', 'latest_bar_time': 1, 'file_age_ms': 1,
            'total_bars': 20, 'clock': {'status': 'aligned'},
            'freshness': {'level': 'ready', 'reasons': []}}}
        graph = SimpleNamespace(propagate=lambda *a, **k: ({'final_trade_decision': 'confidence: 70'}, 'Buy'))
        with tempfile.TemporaryDirectory() as target, patch('ta_runner.EnkeiMarketAdapter.build_snapshot', return_value=snapshot), patch('ta_runner.EnkeiTradingGraph.build', return_value=graph):
            result = run_analysis('offline-review', 'USDJPY', 'M5', SimpleNamespace(unified_agent_id='offline'), Path(target))
        self.assertEqual(result['status'], 'observe-only')
        self.assertEqual(result['action_bias'], 'observe')


if __name__ == '__main__':
    unittest.main()
