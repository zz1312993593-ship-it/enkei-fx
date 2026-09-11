"""本机 API 护栏：速率限制、请求体上限与变更审计。

- 终端只绑定 127.0.0.1，护栏是纵深防御：即使配置被改绑到其他接口，
  恶意或失控的请求也不会打爆模型/磁盘。
- 限流按客户端 IP 的滑动窗口计数；GET 与写操作分档。
- 变更审计只记录 时间/方法/路径/状态码/来源端口，不记录请求体（避免密钥入日志）。
"""
from __future__ import annotations

import json
import logging
import time
from collections import defaultdict, deque
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

log = logging.getLogger("enkei.api_guard")

# 写操作（POST/PUT/DELETE）每分钟窗口；GET 每分钟窗口
MUTATING_WINDOW_SECONDS = 60.0
MUTATING_MAX_REQUESTS = 60
READ_WINDOW_SECONDS = 10.0
READ_MAX_REQUESTS = 200
# JSON 请求体上限：行情摘要/新闻/专题都在几 KB 量级，256KB 已远超需要
MAX_BODY_BYTES = 256 * 1024

MUTATING_METHODS = {"POST", "PUT", "DELETE", "PATCH"}


class SlidingWindowLimiter:
    """按键（客户端 IP + 档位）的滑动窗口计数器；惰性清理过期队列。"""

    def __init__(self, window_seconds: float, max_requests: int) -> None:
        self.window = window_seconds
        self.max = max_requests
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        now = now if now is not None else time.monotonic()
        hits = self._hits[key]
        cutoff = now - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= self.max:
            hits.append(now)  # 记录被拒请求，避免客户端靠重试刷窗口
            return False
        hits.append(now)
        return True

    def retry_after(self, key: str, now: float | None = None) -> int:
        now = now if now is not None else time.monotonic()
        hits = self._hits.get(key)
        if not hits:
            return 1
        elapsed = now - hits[0]
        return max(1, int(self.window - elapsed) + 1)


class ApiGuardMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, audit_path: Path | None = None) -> None:
        super().__init__(app)
        self._mutating = SlidingWindowLimiter(MUTATING_WINDOW_SECONDS, MUTATING_MAX_REQUESTS)
        self._read = SlidingWindowLimiter(READ_WINDOW_SECONDS, READ_MAX_REQUESTS)
        self._audit_path = audit_path

    def _client_key(self, request: Request) -> str:
        client = request.client
        return f"{client.host}:{client.port}" if client else "unknown"

    async def dispatch(self, request: Request, call_next) -> Response:
        key = self._client_key(request)
        if request.method in MUTATING_METHODS:
            if not self._mutating.allow(key):
                return JSONResponse(
                    status_code=429,
                    content={"error": "rate_limited", "detail": "写操作过于频繁，请稍后再试"},
                    headers={"Retry-After": str(self._mutating.retry_after(key))},
                )
        elif not self._read.allow(key):
            return JSONResponse(
                status_code=429,
                content={"error": "rate_limited", "detail": "请求过于频繁，请稍后再试"},
                headers={"Retry-After": str(self._read.retry_after(key))},
            )

        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content={"error": "payload_too_large", "detail": f"请求体超过 {MAX_BODY_BYTES} 字节上限"},
            )

        response = await call_next(request)
        if request.method in MUTATING_METHODS:
            self._audit(request, response.status_code, key)
        return response

    def _audit(self, request: Request, status_code: int, key: str) -> None:
        if self._audit_path is None:
            return
        entry = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "method": request.method,
            "path": request.url.path,
            "status": status_code,
            "client": key,
        }
        try:
            self._audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self._audit_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            log.exception("变更审计写入失败 path=%s", self._audit_path)
