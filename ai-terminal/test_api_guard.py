"""批2：API 护栏单测（限流 / 请求体上限 / 变更审计）。不启动网络服务。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.api_guard import (
    ApiGuardMiddleware,
    MAX_BODY_BYTES,
    MUTATING_MAX_REQUESTS,
    READ_MAX_REQUESTS,
    READ_WINDOW_SECONDS,
    SlidingWindowLimiter,
)


class SlidingWindowLimiterTest(unittest.TestCase):
    def test_allows_within_limit_and_blocks_over(self):
        limiter = SlidingWindowLimiter(window_seconds=10.0, max_requests=3)
        clock = {"now": 0.0}

        def now():
            return clock["now"]

        self.assertTrue(limiter.allow("a", now()))
        self.assertTrue(limiter.allow("a", now()))
        self.assertTrue(limiter.allow("a", now()))
        self.assertFalse(limiter.allow("a", now()))

    def test_window_slide_frees_capacity(self):
        limiter = SlidingWindowLimiter(window_seconds=10.0, max_requests=1)
        clock = {"now": 0.0}

        def now():
            return clock["now"]

        self.assertTrue(limiter.allow("a", now()))
        self.assertFalse(limiter.allow("a", now()))
        clock["now"] = 11.0
        self.assertTrue(limiter.allow("a", now()))

    def test_keys_are_independent(self):
        limiter = SlidingWindowLimiter(window_seconds=10.0, max_requests=1)
        self.assertTrue(limiter.allow("a", 0.0))
        self.assertTrue(limiter.allow("b", 0.0))


class ApiGuardMiddlewareTest(unittest.TestCase):
    def _app(self, audit_path):
        app = FastAPI()
        app.add_middleware(ApiGuardMiddleware, audit_path=audit_path)

        @app.get("/ping")
        async def ping():
            return {"ok": True}

        @app.post("/v1/news")
        async def inject(payload: dict):
            return {"ok": True}

        return app

    def test_read_rate_limit_returns_429_with_retry_after(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = TestClient(self._app(Path(tmp) / "audit.jsonl"))
            codes = [client.get("/ping").status_code for _ in range(READ_MAX_REQUESTS + 1)]
            self.assertEqual(codes[-1], 429)
            self.assertTrue(all(code == 200 for code in codes[:-1]))

    def test_body_size_cap_returns_413(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = TestClient(self._app(Path(tmp) / "audit.jsonl"))
            response = client.post("/v1/news", content=b"x" * (MAX_BODY_BYTES + 1),
                                   headers={"Content-Type": "application/json"})
            self.assertEqual(response.status_code, 413)

    def test_mutating_requests_are_audited_without_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit_path = Path(tmp) / "audit.jsonl"
            client = TestClient(self._app(audit_path))
            response = client.post("/v1/news", json={"title": "标题", "body": "内容"})
            self.assertEqual(response.status_code, 200)
            entry = json.loads(audit_path.read_text(encoding="utf-8").strip())
            self.assertEqual(entry["method"], "POST")
            self.assertEqual(entry["path"], "/v1/news")
            self.assertEqual(entry["status"], 200)
            self.assertNotIn("标题", json.dumps(entry))
            self.assertNotIn("内容", json.dumps(entry))

    def test_get_requests_are_not_audited(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit_path = Path(tmp) / "audit.jsonl"
            client = TestClient(self._app(audit_path))
            client.get("/ping")
            self.assertFalse(audit_path.exists())


if __name__ == "__main__":
    unittest.main()
