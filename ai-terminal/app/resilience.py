"""通用外呼韧性层：指数退避重试 + 按目标熔断。

设计约束：
- 调用方（gateway/providers）每次请求都可能新建对象，因此熔断状态必须
  挂在模块级注册表上（按 目标名/地址 键控），否则形同虚设。
- 只重试"基础设施类"失败（超时、不可达、5xx）；认证错误、协议错误、
  模型输出不合法立即抛出，不浪费额度也不掩盖真实问题。
- 熔断半开：reset 秒后放行一次试探请求，成功关闭、失败重新打开。
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field

log = logging.getLogger("enkei.resilience")


class CircuitOpenError(RuntimeError):
    def __init__(self, name: str, reset_in_seconds: float):
        self.name = name
        self.reset_in_seconds = reset_in_seconds
        super().__init__(f"{name} 连续失败已熔断，约 {reset_in_seconds:.0f}s 后自动恢复；期间不再发起外呼")


@dataclass
class RetryPolicy:
    max_attempts: int = 3          # 含首次；=1 表示不重试
    base_backoff: float = 0.5      # 第 n 次重试前睡 base_backoff * 2^(n-1)
    max_backoff: float = 4.0
    jitter: float = 0.2            # 随机抖动比例（±）

    def backoff_for(self, attempt_index: int) -> float:
        """attempt_index 从 1 开始（第一次重试=1）。"""
        delay = min(self.base_backoff * (2 ** (attempt_index - 1)), self.max_backoff)
        return delay * (1 + random.uniform(-self.jitter, self.jitter))


@dataclass
class CircuitBreaker:
    name: str
    failure_threshold: int = 5
    reset_seconds: float = 60.0
    state: str = "closed"                      # closed / open / half-open
    _consecutive_failures: int = field(default=0, repr=False)
    _opened_at: float | None = field(default=None, repr=False)

    def allow(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if self.state == "open":
            if self._opened_at is not None and now - self._opened_at >= self.reset_seconds:
                self.state = "half-open"
                return True
            return False
        return True

    def reset_in(self, now: float | None = None) -> float:
        now = time.monotonic() if now is None else now
        if self.state == "open" and self._opened_at is not None:
            return max(0.0, self.reset_seconds - (now - self._opened_at))
        return 0.0

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._opened_at = None
        self.state = "closed"

    def record_failure(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._consecutive_failures += 1
        if self.state == "half-open" or self._consecutive_failures >= self.failure_threshold:
            self.state = "open"
            self._opened_at = now
            log.warning("熔断打开 target=%s consecutive_failures=%d", self.name, self._consecutive_failures)


class BreakerRegistry:
    """按目标键控的共享熔断器（进程级单例语义）。"""

    def __init__(self, failure_threshold: int = 5, reset_seconds: float = 60.0) -> None:
        self.failure_threshold = failure_threshold
        self.reset_seconds = reset_seconds
        self._breakers: dict[str, CircuitBreaker] = {}

    def get(self, key: str) -> CircuitBreaker:
        breaker = self._breakers.get(key)
        if breaker is None:
            breaker = CircuitBreaker(key, self.failure_threshold, self.reset_seconds)
            self._breakers[key] = breaker
        return breaker

    def reset_all(self) -> None:
        self._breakers.clear()


async def run_with_resilience(
    func,
    *,
    breaker: CircuitBreaker,
    policy: RetryPolicy,
    retryable,
    describe: str,
    sleep=asyncio.sleep,
    clock=None,
):
    """执行 func()（零参异步调用），带熔断与重试。

    retryable(exc) 返回 True 的异常参与退避重试；其余立即抛出。
    重试耗尽后抛出最后一次异常；熔断打开时抛 CircuitOpenError。
    """
    now = clock() if clock else time.monotonic()
    if not breaker.allow(now):
        raise CircuitOpenError(breaker.name, breaker.reset_in(now))
    attempt = 0
    while True:
        try:
            result = await func()
            breaker.record_success()
            return result
        except Exception as exc:
            if not retryable(exc):
                # 非基础设施失败（认证/协议/输出不合法）不计入熔断
                raise
            attempt += 1
            breaker.record_failure(clock() if clock else time.monotonic())
            if attempt >= policy.max_attempts:
                raise
            delay = policy.backoff_for(attempt)
            log.warning("%s 第 %d 次失败（%s），%.2fs 后重试", describe, attempt, exc, delay)
            await sleep(delay)
