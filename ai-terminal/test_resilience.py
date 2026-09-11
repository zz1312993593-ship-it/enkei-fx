"""批3：外呼韧性单测（重试 / 熔断 / Gateway 与 Provider 集成）。全部离线。"""
import asyncio
import unittest

from app import gateway as gateway_mod
from app import resilience
from app.providers import ProviderError, _resilient_call
from app.gateway import GatewayError


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = ""

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


class CircuitBreakerTest(unittest.TestCase):
    def test_opens_after_threshold_and_halfopens_after_reset(self):
        breaker = resilience.CircuitBreaker("t", failure_threshold=3, reset_seconds=60)
        now = [100.0]
        for _ in range(3):
            self.assertTrue(breaker.allow(now[0]))
            breaker.record_failure(now[0])
        self.assertEqual(breaker.state, "open")
        self.assertFalse(breaker.allow(now[0] + 1))
        # reset 到期后放行一次试探
        self.assertTrue(breaker.allow(now[0] + 61))
        self.assertEqual(breaker.state, "half-open")
        # 试探失败 → 重新打开
        breaker.record_failure(now[0] + 61)
        self.assertEqual(breaker.state, "open")

    def test_success_resets_counter(self):
        breaker = resilience.CircuitBreaker("t", failure_threshold=3, reset_seconds=60)
        breaker.record_failure(0)
        breaker.record_failure(0)
        breaker.record_success()
        breaker.record_failure(0)
        breaker.record_failure(0)
        self.assertEqual(breaker.state, "closed")

    def test_reset_in_reports_remaining(self):
        breaker = resilience.CircuitBreaker("t", failure_threshold=1, reset_seconds=30)
        breaker.record_failure(0)
        self.assertGreater(breaker.reset_in(10), 0)


class RunWithResilienceTest(unittest.TestCase):
    def _policy(self, max_attempts=3):
        return resilience.RetryPolicy(max_attempts=max_attempts, base_backoff=0.0)

    def test_retries_retryable_then_succeeds(self):
        breaker = resilience.CircuitBreaker("t", failure_threshold=10, reset_seconds=60)
        calls = {"n": 0}

        async def func():
            calls["n"] += 1
            if calls["n"] < 3:
                err = ProviderError("超时")
                err._retryable = True
                raise err
            return "ok"

        result = asyncio.run(resilience.run_with_resilience(
            func, breaker=breaker, policy=self._policy(),
            retryable=lambda e: isinstance(e, ProviderError) and e.retryable, describe="测试"))
        self.assertEqual(result, "ok")
        self.assertEqual(calls["n"], 3)
        self.assertEqual(breaker.state, "closed")

    def test_non_retryable_raises_immediately(self):
        breaker = resilience.CircuitBreaker("t", failure_threshold=10, reset_seconds=60)
        calls = {"n": 0}

        async def func():
            calls["n"] += 1
            raise ProviderError("输出不是合法 JSON")

        with self.assertRaises(ProviderError):
            asyncio.run(resilience.run_with_resilience(
                func, breaker=breaker, policy=self._policy(),
                retryable=lambda e: isinstance(e, ProviderError) and e.retryable, describe="测试"))
        self.assertEqual(calls["n"], 1)

    def test_exhausts_attempts_then_raises_last_error(self):
        breaker = resilience.CircuitBreaker("t", failure_threshold=100, reset_seconds=60)
        calls = {"n": 0}

        async def func():
            calls["n"] += 1
            err = ProviderError("不可达")
            err._retryable = True
            raise err

        with self.assertRaises(ProviderError):
            asyncio.run(resilience.run_with_resilience(
                func, breaker=breaker, policy=self._policy(max_attempts=2),
                retryable=lambda e: isinstance(e, ProviderError) and e.retryable, describe="测试"))
        self.assertEqual(calls["n"], 2)


class GatewayResilienceTest(unittest.TestCase):
    def setUp(self):
        # 每个用例独立熔断器，快速退避
        gateway_mod._GATEWAY_BREAKERS.reset_all()
        self._policy_backup = gateway_mod._GATEWAY_POLICY
        gateway_mod._GATEWAY_POLICY = resilience.RetryPolicy(max_attempts=3, base_backoff=0.0)

    def tearDown(self):
        gateway_mod._GATEWAY_POLICY = self._policy_backup

    def _client(self):
        cfg = gateway_mod.GatewayConfig(
            librechat_base_url="http://127.0.0.1:9999",
            librechat_api_key="k",
            unified_agent_id="agent_x",
            configured=True,
        )
        return gateway_mod.LibreChatClient(cfg)

    def test_ask_agent_retries_5xx_then_succeeds(self):
        client = self._client()
        responses = [FakeResponse(500), FakeResponse(503),
                     FakeResponse(200, {"output_text": '{"ok": 1}'})]

        async def fake_send(method, url, *, timeout, json_body=None):
            return responses.pop(0)

        client._send = fake_send
        result = asyncio.run(client.ask_agent("agent_x", [{"role": "user", "content": "x"}], timeout=1))
        self.assertEqual(result["ok"], 1)

    def test_ask_agent_does_not_retry_auth_failure(self):
        client = self._client()
        calls = {"n": 0}

        async def fake_send(method, url, *, timeout, json_body=None):
            calls["n"] += 1
            return FakeResponse(401)

        client._send = fake_send
        with self.assertRaises(GatewayError) as ctx:
            asyncio.run(client.ask_agent("agent_x", [{"role": "user", "content": "x"}], timeout=1))
        self.assertEqual(ctx.exception.category, "auth_failed")
        self.assertEqual(calls["n"], 1)

    def test_circuit_opens_after_repeated_infra_failures(self):
        gateway_mod._GATEWAY_BREAKERS.reset_all()
        gateway_mod._GATEWAY_BREAKERS.failure_threshold = 1  # 一次即熔断
        client = self._client()

        async def fake_send(method, url, *, timeout, json_body=None):
            raise GatewayError("timeout", "超时")

        client._send = fake_send
        with self.assertRaises(GatewayError):
            asyncio.run(client.ask_agent("agent_x", [{"role": "user", "content": "x"}], timeout=1))
        # 熔断后下一次调用直接拒绝，不再外呼
        with self.assertRaises(GatewayError) as ctx:
            asyncio.run(client.ask_agent("agent_x", [{"role": "user", "content": "x"}], timeout=1))
        self.assertEqual(ctx.exception.category, "circuit_open")


class ProviderResilienceTest(unittest.TestCase):
    def setUp(self):
        from app.providers import _PROVIDER_BREAKERS
        self._registry = _PROVIDER_BREAKERS
        self._registry.reset_all()

    def test_resilient_call_maps_circuit_open(self):
        # 注册表中目标 "p" 预置为熔断态（超大 reset，避免真实时钟越过重置点）
        breaker = self._registry.get("p")
        breaker.failure_threshold = 1
        breaker.reset_seconds = 1e9
        breaker.record_failure()

        async def send():
            return FakeResponse(200)

        with self.assertRaises(ProviderError):
            asyncio.run(_resilient_call("p", "测试", send))


if __name__ == "__main__":
    unittest.main()
