"""批4：新闻闭环与失败回退单测。全部离线，缓存写到临时目录。"""
import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import news as news_mod
from app.data_quality import judgment_errors


def item(title, source="src"):
    return {
        "source": source, "title": title, "display_title": title,
        "body": "body", "link": "https://example.com/a",
        "published": news_mod._now_iso(), "created_at": news_mod._now_iso(),
        "translation_status": "original", "translation_error": None, "failure_reason": None,
    }


class NewsLoopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        patcher_cache = patch.object(news_mod, "CACHE_FILE", root / "cache.json")
        patcher_src = patch.object(news_mod, "SOURCES_FILE", root / "sources.json")
        patcher_cache.start()
        patcher_src.start()
        self.addCleanup(patcher_cache.stop)
        self.addCleanup(patcher_src.stop)
        # Prevent ordinary cache tests from contacting the user's model gateway.
        # Translation tests override this mock with their own response fixtures.
        gateway_patch = patch.object(news_mod.gateway_mod.LibreChatClient, "ask_agent", AsyncMock(return_value={"items": []}))
        gateway_patch.start()
        self.addCleanup(gateway_patch.stop)
        ready_cfg = news_mod.gateway_mod.GatewayConfig(
            librechat_base_url="http://127.0.0.1:3080", librechat_api_key="test-key",
            unified_agent_id="agent-test", configured=True,
        )
        config_patch = patch.object(news_mod.gateway_mod, "load_gateway_config", return_value=ready_cfg)
        config_patch.start()
        self.addCleanup(config_patch.stop)

    def _store(self):
        store = news_mod.NewsStore()
        store._save = lambda: None  # 防御：即使测试路径错误也不落盘
        return store

    # ---------- 相关度 ----------
    def test_relevance_matches_pair_and_macro_terms(self):
        self.assertTrue(news_mod._relevant("Fed raises rates, dollar jumps", "USDJPY"))
        self.assertTrue(news_mod._relevant("ECB officials signal easing", "EURUSD"))
        self.assertTrue(news_mod._relevant("Inflation prints hot ahead of the FOMC", "USDJPY"))  # 宏观词命中
        self.assertFalse(news_mod._relevant("Local football match result", "USDJPY"))

    # ---------- 去重 ----------
    async def test_refresh_dedups_same_title_across_sources(self):
        store = self._store()
        store._sources = [{"name": "a", "url": "u1"}, {"name": "b", "url": "u2"}]
        same = item("Boj intervenes as yen slides")
        with patch.object(news_mod.NewsStore, "_fetch_rss", AsyncMock(return_value=[same])):
            await store.refresh_once()
            await store.refresh_once()  # 同一标题再次抓到
        titles = [x["title"] for x in store._items]
        self.assertEqual(titles.count(same["title"]), 1)
        self.assertEqual(store._source_status["a"]["ok"], True)

    # ---------- 来源失败降级 ----------
    async def test_source_failure_marks_status_and_keeps_other_sources(self):
        store = self._store()
        store._sources = [{"name": "good", "url": "u1"}, {"name": "bad", "url": "u2"}]

        async def fetch(url, name):
            if name == "bad":
                raise RuntimeError("network unreachable")
            return [item("Dollar steadies ahead of Fed", source=name)]

        with patch.object(news_mod.NewsStore, "_fetch_rss", side_effect=fetch):
            await store.refresh_once()
        self.assertEqual(store._source_status["bad"]["ok"], False)
        self.assertIn("network unreachable", store._source_status["bad"]["last_error"])
        self.assertEqual(store._source_status["good"]["ok"], True)
        self.assertEqual(len(store._items), 1)

    async def test_all_sources_fail_records_error_and_no_fabrication(self):
        store = self._store()
        store._sources = [{"name": "only", "url": "u1"}]
        with patch.object(news_mod.NewsStore, "_fetch_rss", AsyncMock(side_effect=RuntimeError("dns fail"))):
            await store.refresh_once()
        self.assertEqual(store._items, [])
        self.assertIsNotNone(store._last_error)
        self.assertIn("only", store._last_error)

    # ---------- 过期标注 ----------
    async def test_list_all_marks_stale_cache_expired(self):
        store = self._store()
        store._items = [item("Old headline")]
        old = (datetime.now(timezone.utc) - timedelta(seconds=news_mod.CACHE_TTL_SECONDS + 60)).isoformat(timespec="seconds")
        store._last_refresh = old
        data = await store.list_all(10)
        self.assertTrue(data["cache_expired"])

    async def test_fresh_cache_not_expired(self):
        store = self._store()
        store._items = [item("Fresh headline")]
        store._last_refresh = news_mod._now_iso()
        data = await store.list_all(10)
        self.assertFalse(data["cache_expired"])

    # ---------- 源配置 ----------
    async def test_set_sources_caps_at_twelve_and_defaults_on_empty(self):
        store = self._store()
        many = [{"name": f"s{i}", "url": f"https://e/{i}"} for i in range(15)]
        result = await store.set_sources(many)
        self.assertEqual(len(result), 12)
        result = await store.set_sources([])
        self.assertEqual(result, [dict(x) for x in news_mod.DEFAULT_RSS_SOURCES])

    # ---------- 手动注入上限 ----------
    async def test_inject_truncates_long_fields(self):
        store = self._store()
        await store.inject("T" * 500, "B" * 5000, "S" * 100)
        self.assertLessEqual(len(store._items[0]["title"]), 200)
        self.assertLessEqual(len(store._items[0]["body"]), 400)
        self.assertEqual(store._items[0]["source"], "S" * 40)

    # ---------- 模型输出超长必须被拒 ----------
    def test_overlong_rationale_rejected(self):
        base = {"market_regime": "range", "action_bias": "wait", "confidence": 60,
                "recommended_model": "ema-cross", "rationale_zh": "测" * 801}
        self.assertTrue(judgment_errors(base))

    # ---------- 翻译结果解析兼容性（批E 实测发现的缺陷） ----------
    def _store_with_items(self, n=2):
        store = self._store()
        for i in range(n):
            store._items.append(item(f"Dollar headline {i}", source="rss"))
        return store

    async def test_enrich_accepts_news_curation_shape(self):
        store = self._store_with_items()
        # 统一分析体实际返回 {"news_curation": [...]}（模型自带指令包了一层键）
        payload = {"news_curation": [
            {"index": 0, "translation": "美元头条0", "summary": "摘要0", "importance": "high", "relevance": "usd"},
            {"index": 1, "translation": "美元头条1", "summary": "摘要1", "importance": "normal", "relevance": "usd"},
        ]}
        with patch.object(news_mod.gateway_mod.LibreChatClient, "ask_agent", AsyncMock(return_value=payload)):
            ok = await store.enrich_recent("zh")
        self.assertTrue(ok)
        self.assertEqual(store._items[0]["translation_status"], "translated")
        self.assertEqual(store._items[0]["translations"]["zh"], "美元头条0")

    async def test_enrich_accepts_bare_list_and_string_index(self):
        store = self._store_with_items()
        payload = [{"index": "0", "translation": "头条零"}, {"index": "1", "translation": "头条一"}]
        with patch.object(news_mod.gateway_mod.LibreChatClient, "ask_agent", AsyncMock(return_value=payload)):
            ok = await store.enrich_recent("zh")
        self.assertTrue(ok)
        self.assertEqual(store._items[1]["translations"]["zh"], "头条一")

    async def test_enrich_unrecognized_shape_leaves_items_pending(self):
        store = self._store_with_items()
        with patch.object(news_mod.gateway_mod.LibreChatClient, "ask_agent", AsyncMock(return_value={"unexpected": []})):
            ok = await store.enrich_recent("zh")
        self.assertFalse(ok)
        self.assertEqual(store._items[0]["translation_status"], "original")


if __name__ == "__main__":
    unittest.main()
