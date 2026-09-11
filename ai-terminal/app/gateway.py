"""圆衡 Enkei 外部 AI 终端 - 统一 AI 网关适配层（LibreChat 主链路 + Ollama 本地备用）

架构（M1「LibreChat 统一模型入口」）：
- 圆衡主程序只访问 AI 终端 127.0.0.1:8710；
- AI 终端通过本模块访问 LibreChat Agents API（OpenAI 兼容）；
- 本地 Ollama 仅作为可选降级后端，不是圆衡的前置依赖；
- 密钥由 LibreChat 管理，圆衡只保存 LibreChat 地址 / 圆衡专用 API Key / Agent ID /
  可选 Ollama 备用地址；密钥绝不进入日志、截图、公开包、Git 或测试样例。

LibreChat Agents API（Beta，官方文档）：
- POST {base}/api/agents/v1/chat/completions  OpenAI 兼容，model=agent_id
- GET  {base}/api/agents/v1/models            返回可访问的 agent 列表
- 认证：Authorization: Bearer <librechat_api_key>
- 前提：LibreChat 需启用 interface.remoteAgents.use
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import config
from . import resilience
from . import security

log = logging.getLogger("enkei.terminal.gateway")

# ============ 网关配置 ============

GATEWAY_CONFIG_FIELDS = (
    "librechat_base_url",
    "librechat_api_key",
    "unified_analysis_enabled",
    "unified_agent_id",
    "m5_agent_id",
    "m15_agent_id",
    "local_fallback_enabled",
    "ollama_base_url",
    "ollama_fallback_model",
)

# 已知但尚未配置的提供商提示目录（不写死为可调用，仅作前端提示）
KNOWN_PROVIDERS = [
    {"provider": "deepseek", "display_name": "DeepSeek", "cloud": True},
    {"provider": "openai", "display_name": "OpenAI", "cloud": True},
    {"provider": "anthropic", "display_name": "Anthropic Claude", "cloud": True},
    {"provider": "qwen", "display_name": "Qwen/DashScope", "cloud": True},
    {"provider": "zhipu", "display_name": "智谱 GLM", "cloud": True},
    {"provider": "doubao", "display_name": "字节豆包", "cloud": True},
    {"provider": "moonshot", "display_name": "Moonshot Kimi", "cloud": True},
    {"provider": "openrouter", "display_name": "OpenRouter", "cloud": True},
    {"provider": "gemini", "display_name": "Google Gemini", "cloud": True},
    {"provider": "minimax", "display_name": "MiniMax", "cloud": True},
    {"provider": "groq", "display_name": "Groq", "cloud": True},
    {"provider": "custom", "display_name": "用户自定义 OpenAI 兼容端点", "cloud": True},
]


@dataclass
class GatewayConfig:
    """圆衡侧唯一保存的网关配置（本机阶段不做 AES 加密，但严禁进日志/包）。"""

    librechat_base_url: str = ""
    librechat_api_key: str = ""
    # 默认采用一个分析体处理多个周期。旧版 M5/M15 双 Agent 字段仍保留，
    # 以便已有配置无需迁移也能继续运行。
    unified_analysis_enabled: bool = True
    unified_agent_id: str = ""
    m5_agent_id: str = ""
    m15_agent_id: str = ""
    local_fallback_enabled: bool = False
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_fallback_model: str = ""
    configured: bool = False

    def agent_for(self, timeframe: str) -> str:
        if self.unified_analysis_enabled and self.unified_agent_id:
            return self.unified_agent_id
        return self.m15_agent_id if timeframe == "M15" else self.m5_agent_id

    def analysis_mode(self) -> str:
        if self.unified_analysis_enabled and self.unified_agent_id:
            return "unified_agent"
        if self.unified_analysis_enabled and not (self.m5_agent_id or self.m15_agent_id):
            return "unified_local"
        return "legacy_per_timeframe"

    def has_agent(self) -> bool:
        return bool(self.unified_agent_id or self.m5_agent_id or self.m15_agent_id)

    def is_librechat_ready(self) -> bool:
        return bool(self.configured and self.librechat_base_url and self.librechat_api_key
                    and self.has_agent())


def _resolve_gateway_file() -> Path | None:
    """优先私有配置目录，其次终端数据目录；都不存在返回 None（视为未配置）。"""
    candidates = [
        Path(config.PRIVATE_CONFIG_DIR) / "gateway.json",
        Path(config.LEGACY_PRIVATE_CONFIG_DIR) / "gateway.json",
        config.CONFIG_DIR / "gateway.json",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def load_gateway_config() -> GatewayConfig:
    """读取网关配置。文件缺失/损坏时返回未配置（不崩溃），并允许环境变量覆盖。"""
    cfg = GatewayConfig()
    path = _resolve_gateway_file()
    if path is not None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for key in GATEWAY_CONFIG_FIELDS:
                if key in raw and isinstance(raw[key], (str, bool)):
                    setattr(cfg, key, raw[key])
            cfg.configured = True
            # 校验必需项
            if not (cfg.librechat_base_url and cfg.librechat_api_key and cfg.has_agent()):
                cfg.configured = False
        except Exception as e:  # 损坏配置按未配置处理，不崩溃
            log.warning("gateway 配置文件无法解析（按未配置处理）: %s", e)
    # 环境变量覆盖（仅开发/联调便利，不落入日志）
    env_map = {
        "ENKEI_LIBRECHAT_BASE_URL": "librechat_base_url",
        "ENKEI_LIBRECHAT_API_KEY": "librechat_api_key",
        "ENKEI_UNIFIED_AGENT_ID": "unified_agent_id",
        "ENKEI_M5_AGENT_ID": "m5_agent_id",
        "ENKEI_M15_AGENT_ID": "m15_agent_id",
        "ENKEI_OLLAMA_BASE_URL": "ollama_base_url",
        "ENKEI_OLLAMA_FALLBACK_MODEL": "ollama_fallback_model",
    }
    import os
    for env, attr in env_map.items():
        val = os.environ.get(env)
        if val:
            setattr(cfg, attr, val)
    if os.environ.get("ENKEI_LOCAL_FALLBACK_ENABLED") == "1":
        cfg.local_fallback_enabled = True
    if "ENKEI_UNIFIED_ANALYSIS_ENABLED" in os.environ:
        cfg.unified_analysis_enabled = _coerce_bool(os.environ["ENKEI_UNIFIED_ANALYSIS_ENABLED"])
    cfg.configured = bool(cfg.librechat_base_url and cfg.librechat_api_key and cfg.has_agent())
    return cfg


# ============ LibreChat 客户端适配器 ============

class GatewayError(Exception):
    """网关调用失败（分类错误）。"""

    def __init__(self, category: str, message: str, status: int | None = None):
        self.category = category  # not_configured / unreachable / auth_failed / agent_not_found / invalid_json / http_error / timeout / circuit_open
        self.message = message
        self.status = status
        super().__init__(f"[{category}] {message}")

    @property
    def retryable(self) -> bool:
        """只有基础设施类失败才值得退避重试；认证/协议/输出错误立即抛出。"""
        if self.category in ("unreachable", "timeout"):
            return True
        return self.status is not None and self.status >= 429


def _chat_content_text(value: object) -> str:
    """Normalise OpenAI-compatible text and content-part responses."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("text", "content"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                candidate = item.get("text") or item.get("content")
                if isinstance(candidate, str):
                    parts.append(candidate)
        return "\n".join(parts)
    return ""


def _agent_message_text(message: object) -> str:
    """读取 Agents/OpenAI 兼容回复中实际承载最终文本的字段。

    部分推理模型会把可见回答置于 ``reasoning_content`` 或 ``reasoning``，而
    ``content`` 为空。优先保留标准 content，只有它为空时才使用兼容字段。
    """
    if not isinstance(message, dict):
        return ""
    content = _chat_content_text(message.get("content"))
    if content.strip():
        return content
    for key in ("reasoning_content", "reasoning", "output_text", "text"):
        candidate = _chat_content_text(message.get(key))
        if candidate.strip():
            return candidate
    return ""


def _redact(url: str) -> str:
    return security.sanitize(url)


# ============ 外呼韧性（指数退避 + 按目标熔断） ============
# 客户端对象按请求构造，熔断状态必须挂在模块级注册表才跨请求有效。
_GATEWAY_BREAKERS = resilience.BreakerRegistry(
    failure_threshold=int(os.environ.get("ENKEI_GATEWAY_BREAKER_THRESHOLD", "5")),
    reset_seconds=float(os.environ.get("ENKEI_GATEWAY_BREAKER_RESET_S", "60")),
)
_GATEWAY_POLICY = resilience.RetryPolicy(max_attempts=1 + int(os.environ.get("ENKEI_GATEWAY_MAX_RETRIES", "2")))


def _gateway_retryable(exc: Exception) -> bool:
    return isinstance(exc, GatewayError) and exc.retryable


class LibreChatClient:
    """LibreChat Agents API 客户端。集中管理协议，不散落到 scheduler/main。"""

    def __init__(self, cfg: GatewayConfig | None = None):
        self.cfg = cfg or load_gateway_config()

    def _base(self) -> str:
        return self.cfg.librechat_base_url.rstrip("/")

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.cfg.librechat_api_key}",
            "Content-Type": "application/json",
        }

    async def _send(self, method: str, url: str, *, timeout: float, json_body: dict | None = None):
        """单次 HTTP 发送（不含重试）；网络/超时/状态码错误分类为 GatewayError。"""
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                if method == "GET":
                    return await client.get(url, headers=self._headers())
                return await client.post(url, json=json_body, headers=self._headers())
        except httpx.TimeoutException as e:
            raise GatewayError("timeout", f"LibreChat 请求超时({timeout}s): {_redact(str(e))}") from e
        except httpx.HTTPError as e:
            raise GatewayError("unreachable", f"LibreChat 不可达: {_redact(str(e))}") from e

    async def _resilient_send(self, describe: str, method: str, url: str, *, timeout: float, json_body: dict | None = None):
        """带重试与熔断的发送；5xx/429 视为可重试的基础设施失败。"""
        breaker = _GATEWAY_BREAKERS.get(self._base())

        async def attempt():
            resp = await self._send(method, url, timeout=timeout, json_body=json_body)
            if resp.status_code >= 500 or resp.status_code == 429:
                raise GatewayError("http_error", f"LibreChat HTTP {resp.status_code}", status=resp.status_code)
            return resp

        try:
            return await resilience.run_with_resilience(
                attempt, breaker=breaker, policy=_GATEWAY_POLICY,
                retryable=_gateway_retryable, describe=describe)
        except resilience.CircuitOpenError as e:
            raise GatewayError("circuit_open", str(e)) from e

    async def list_agents(self, timeout: float = 5.0) -> list[dict]:
        """GET /api/agents/v1/models，返回可访问的 agent 列表。失败抛 GatewayError。"""
        if not self.cfg.librechat_base_url:
            raise GatewayError("not_configured", "LibreChat 未配置")
        url = f"{self._base()}/api/agents/v1/models"
        resp = await self._resilient_send("LibreChat list_agents", "GET", url, timeout=timeout)
        if resp.status_code in (401, 403):
            raise GatewayError("auth_failed", f"LibreChat 认证失败 HTTP {resp.status_code}")
        if resp.status_code == 404:
            raise GatewayError("agent_not_found", "LibreChat agents API 未启用（需开启 remoteAgents.use）")
        if resp.status_code != 200:
            raise GatewayError("http_error", f"LibreChat HTTP {resp.status_code}", status=resp.status_code)
        try:
            data = resp.json()
        except Exception as e:
            raise GatewayError("invalid_json", "LibreChat 返回非 JSON") from e
        # OpenAI 兼容 /models 通常返回 {object:"list", data:[{id, object:"model", owned_by,...}]}
        items = data.get("data") if isinstance(data, dict) else data
        if not isinstance(items, list):
            return []
        return [it for it in items if isinstance(it, dict)]

    def build_messages(self, market_summary: dict, language: str = "zh", news_text: str = "") -> list[dict]:
        """组装发送给决策 Agent 的 OpenAI 消息。返回 messages 列表。"""
        from .providers import build_judge_prompt
        system, user = build_judge_prompt(market_summary, news_text, language)
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": (
                f"{user}\n\n【输出语言】请使用{language}撰写 rationale。\n"
                "【硬性约束】只输出合法 JSON 对象，不要 Markdown，不要多余文字。"
            )},
        ]

    async def ask_agent(
        self,
        agent_id: str,
        messages: list[dict],
        timeout: float = 180.0,
        request_id: str = "",
    ) -> dict:
        """调用单个 Agent 做一次判断，返回模型核心判断 dict。

        接收完整回复后再解析（不消费流式半截内容）；解析失败抛 GatewayError。
        """
        if not agent_id:
            raise GatewayError("not_configured", "Agent ID 未配置")
        # Prefer LibreChat's stateful Responses endpoint.  A stable previous
        # response id keeps one Enkei analysis thread across model switches;
        # LibreChat/Mongo owns the visible history, while Enkei stores only the
        # opaque continuation id in its private directory.
        state_file = config.PRIVATE_CONFIG_DIR / "librechat-conversations.json"
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except Exception:
            state = {}
        response_url = f"{self._base()}/api/agents/v1/responses"
        response_payload: dict[str, Any] = {
            "model": agent_id, "input": messages, "store": True, "stream": False,
            "metadata": {"source": "enkei", "thread": "unified-analysis"},
        }
        previous_id = state.get("unified-analysis") if isinstance(state, dict) else None
        if isinstance(previous_id, str) and previous_id:
            response_payload["previous_response_id"] = previous_id
        started = time.monotonic()
        response = await self._resilient_send(
            f"LibreChat responses {agent_id}", "POST", response_url,
            timeout=timeout, json_body=response_payload)
        if response.status_code in (401, 403):
            # Authentication failures are definitive. Falling through to a
            # second endpoint only duplicates a rejected request and makes the
            # UI appear to hang.
            raise GatewayError("auth_failed", f"LibreChat 认证失败 HTTP {response.status_code}")
        if response.status_code not in (200, 404):
            raise GatewayError("http_error", f"LibreChat Responses HTTP {response.status_code}", status=response.status_code)
        if response.status_code == 200:
            try:
                body = response.json()
                content = body.get("output_text") or ""
                if not content:
                    for output in body.get("output") or []:
                        for part in output.get("content") or []:
                            if part.get("type") in {"output_text", "text"}:
                                content += str(part.get("text") or "")
                response_id = body.get("id")
                if isinstance(response_id, str) and response_id:
                    config.PRIVATE_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                    state_file.write_text(json.dumps({**(state if isinstance(state, dict) else {}), "unified-analysis": response_id}), encoding="utf-8")
                from .providers import extract_json
                obj = extract_json(content)
                if obj is not None:
                    from .providers import normalize_usage
                    usage = normalize_usage(body.get("usage"))
                    if usage:
                        obj["_usage"] = usage
                    obj["_latency_ms"] = int((time.monotonic() - started) * 1000)
                    obj["_request_id"] = request_id
                    return obj
            except Exception as exc:
                log.warning("LibreChat stateful response parse failed: %s", type(exc).__name__)

        # Compatibility fallback for LibreChat versions whose beta Responses
        # persistence is unavailable. The local audit ledger still retains the
        # full Enkei request/result chain.
        url = f"{self._base()}/api/agents/v1/chat/completions"
        payload = {
            "model": agent_id,
            "messages": messages,
            "stream": False,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        }
        started = time.monotonic()
        resp = await self._resilient_send(
            f"LibreChat ask_agent {agent_id}", "POST", url, timeout=timeout, json_body=payload)
        latency_ms = int((time.monotonic() - started) * 1000)
        if resp.status_code in (401, 403):
            raise GatewayError("auth_failed", f"LibreChat 认证失败 HTTP {resp.status_code}")
        if resp.status_code == 404:
            raise GatewayError("agent_not_found", f"Agent {agent_id} 不存在")
        if resp.status_code != 200:
            raise GatewayError("http_error", f"Agent HTTP {resp.status_code}", status=resp.status_code)
        try:
            body = resp.json()
            choice = body["choices"][0]
            if choice.get("finish_reason") not in (None, "stop"):
                raise ValueError("Agent response did not finish normally")
            content = _agent_message_text(choice["message"])
        except Exception as e:
            raise GatewayError("invalid_json", f"Agent 响应结构异常: {e}")
        from .providers import extract_json
        obj = extract_json(content)
        if obj is None:
            # Keep only a short, sanitized preview for local diagnosis.  This
            # is model output, never a request header or API key.
            log.warning("Agent JSON parse failed type=%s chars=%d preview=%s", type(content).__name__, len(content), _redact(content[:240]).replace("\n", " "))
            raise GatewayError("invalid_json", "Agent 输出不是合法 JSON")
        obj["_latency_ms"] = latency_ms
        obj["_request_id"] = request_id
        from .providers import normalize_usage
        usage = normalize_usage(body.get("usage"))
        if usage:
            obj["_usage"] = usage
        return obj

    async def test_agent(self, agent_id: str, timeout: float = 180.0) -> dict:
        """任务 D：对指定 Agent 发起一次最小结构化 JSON 请求。

        返回 {ok, latency_ms, json_valid, raw_valid}；失败抛 GatewayError（分类）。
        绝不回传密钥、完整请求头或供应商原始敏感错误。
        """
        messages = [
            {"role": "system", "content": "你是连通性测试。只输出一个 JSON 对象，不要其他文字。"},
            {"role": "user", "content": '输出: {"ok": true, "probe": 1}'},
        ]
        started = time.monotonic()
        try:
            obj = await self.ask_agent(agent_id, messages, timeout=timeout, request_id="gateway-test")
        except GatewayError:
            raise
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "ok": True,
            "latency_ms": latency_ms,
            "json_valid": isinstance(obj, dict),
            "raw_valid": obj.get("ok") is True,
        }


# ============ Ollama 本地备用 ============

async def ollama_installed_models(base_url: str = "http://127.0.0.1:11434", timeout: float = 3.0) -> list[dict]:
    """动态发现本机 Ollama 已安装模型。未安装/不可达返回空列表（不抛错）。"""
    try:
        from .providers import ollama_health
        health = await ollama_health(base_url, timeout)
        if not health.get("ok"):
            return []
        models = health.get("models", [])
        return [{"model": m, "local": True} for m in models]
    except Exception:
        return []


async def ollama_ping(base_url: str = "http://127.0.0.1:11434", timeout: float = 3.0) -> bool:
    models = await ollama_installed_models(base_url, timeout)
    return bool(models)


# ============ 目录与健康 ============

async def collect_model_catalog(cfg: GatewayConfig | None = None) -> dict:
    """聚合模型目录：LibreChat Agent / 本机 Ollama / 已配置直连云端 / 已知提供商。"""
    cfg = cfg or load_gateway_config()
    agents: list[dict] = []
    librechat_status = "not_configured"
    librechat_error = ""
    if cfg.librechat_base_url and cfg.librechat_api_key:
        client = LibreChatClient(cfg)
        try:
            raw_agents = await client.list_agents()
            librechat_status = "ok"
            for it in raw_agents:
                aid = it.get("id") or it.get("model")
                if not aid:
                    continue
                agents.append({
                    "provider": "librechat",
                    "model_or_agent": aid,
                    "display_name": it.get("display_name") or it.get("name") or aid,
                    "local": False,
                    "available": True,
                    "health_status": "healthy",
                    "price_tier": "librechat",
                    "compute_tier": "standard",
                    "context_tier": "standard",
                    "json_capable": True,
                    "recommended_timeframes": ["M5", "M15"],
                    "last_latency_ms": None,
                    "configured_by": "LibreChat",
                })
        except GatewayError as e:
            librechat_status = e.category
            librechat_error = e.message
    elif cfg.librechat_base_url or cfg.librechat_api_key:
        librechat_status = "incomplete"

    ollama_models = await ollama_installed_models(cfg.ollama_base_url)
    for m in ollama_models:
        agents.append({
            "provider": "ollama",
            "model_or_agent": m["model"],
            "display_name": m["model"],
            "local": True,
            "available": True,
            "health_status": "healthy",
            "price_tier": "local",
            "compute_tier": "deep" if "14b" in m["model"] else "fast",
            "context_tier": "16k",
            "json_capable": True,
            "recommended_timeframes": ["M5", "M15"],
            "last_latency_ms": None,
            "configured_by": "Ollama",
        })

    # 直连云端模型使用独立的私有 providers.json。这里只暴露已启用状态与
    # 模型名，永不返回 API Key、请求头或供应商原始配置。
    direct_cfg = config.load_provider_config()
    configured_direct: set[str] = set()
    for provider_name, provider in (direct_cfg.get("providers") or {}).items():
        if not isinstance(provider, dict):
            continue
        if not (provider.get("enabled") and provider.get("base_url") and provider.get("api_key")):
            continue
        configured_direct.add(provider_name)
        seen_models: set[str] = set()
        for role, model in (provider.get("models") or {}).items():
            model = str(model or "").strip()
            if not model or model in seen_models:
                continue
            seen_models.add(model)
            agents.append({
                "provider": provider_name,
                "model_or_agent": model,
                "display_name": model,
                "local": False,
                "available": True,
                "health_status": "configured",
                "price_tier": "cloud",
                "compute_tier": "standard",
                "context_tier": "provider_managed",
                "json_capable": True,
                "recommended_timeframes": ["M5", "M15"],
                "last_latency_ms": None,
                "configured_by": "私有配置",
            })

    providers = [dict(p, available=p["provider"] in configured_direct,
                      health_status="configured" if p["provider"] in configured_direct else "not_configured")
                 for p in KNOWN_PROVIDERS]

    return {
        "configured": cfg.configured,
        "librechat": {"status": librechat_status, "error": librechat_error,
                      "base_url": _redact(cfg.librechat_base_url)},
        "local_fallback_enabled": cfg.local_fallback_enabled,
        "analysis_mode": cfg.analysis_mode(),
        "unified_agent": cfg.unified_agent_id,
        "m5_agent": cfg.m5_agent_id,
        "m15_agent": cfg.m15_agent_id,
        "available_agents": agents,
        "known_providers": providers,
    }


def sort_catalog(catalog: dict, sort: str) -> dict:
    key_map = {
        "provider": lambda it: it.get("provider", ""),
        "deployment": lambda it: (0 if it.get("local") else 1),
        "availability": lambda it: (0 if it.get("available") else 1),
        "price": lambda it: {"local": 0, "free": 1, "low": 2, "mid": 3, "high": 4}.get(it.get("price_tier", ""), 9),
        "compute": lambda it: {"fast": 0, "standard": 1, "deep": 2}.get(it.get("compute_tier", ""), 9),
        "latency": lambda it: (it.get("last_latency_ms") if isinstance(it.get("last_latency_ms"), int) else 10 ** 9),
    }
    fn = key_map.get(sort, key_map["provider"])
    catalog["available_agents"] = sorted(catalog.get("available_agents", []), key=fn)
    return catalog


async def gateway_probe(cfg: GatewayConfig | None = None, timeout: float = 5.0) -> tuple[bool, str]:
    """轻量线上健康探测：只列 agent、不触发推理。返回 (ok, detail)。"""
    cfg = cfg or load_gateway_config()
    if not cfg.is_librechat_ready():
        return False, "not_configured"
    client = LibreChatClient(cfg)
    try:
        agents = await client.list_agents(timeout=timeout)
        if not agents:
            return False, "no_agent"
        return True, "ok"
    except GatewayError as e:
        return False, e.category


# ============ 配置脱敏与持久化（GET/PUT /v1/gateway/config）============

# GET/PUT 允许的对外字段（脱敏视图，不含明文 key）
GATEWAY_PUBLIC_FIELDS = (
    "librechat_base_url",
    "unified_analysis_enabled",
    "unified_agent_id",
    "m5_agent_id",
    "m15_agent_id",
    "local_fallback_enabled",
    "ollama_base_url",
    "ollama_fallback_model",
)


def masked_gateway_config(cfg: GatewayConfig | None = None) -> dict:
    """返回脱敏后的网关配置视图（GET /v1/gateway/config）。

    - 不包含 librechat_api_key 明文，仅以 api_key_set 布尔表示是否已配置；
    - 供主程序完成 M5/M15 Agent 选择与热生效，不重复保存供应商密钥。
    """
    cfg = cfg or load_gateway_config()
    view = {f: getattr(cfg, f) for f in GATEWAY_PUBLIC_FIELDS}
    view["api_key_set"] = bool(cfg.librechat_api_key)
    view["configured"] = cfg.configured
    return view


def save_gateway_config(updates: dict) -> GatewayConfig:
    """将可修改字段写入私有 gateway.json（PUT /v1/gateway/config）。

    规则：
    - 仅更新 updates 中出现的字段，其余保留现有值（部分更新）；
    - librechat_api_key 仅在显式提交且非空时写入；空/缺失表示不更新，
      GET 与日志绝不回传明文 key；
    - local_fallback_enabled 接受 bool 或 'true'/'false'/'1'/'0' 字符串；
    - 写入成功后返回最新配置（内存态）。绝不记录明文 key 到日志。
    """
    cfg = load_gateway_config()
    for field in GATEWAY_CONFIG_FIELDS:
        if field not in updates:
            continue
        val = updates[field]
        if field == "librechat_api_key":
            if isinstance(val, str) and val.strip():
                cfg.librechat_api_key = val.strip()
            # 空/None 表示不更新，保留现有 key
            continue
        if field == "local_fallback_enabled":
            cfg.local_fallback_enabled = _coerce_bool(val)
            continue
        if field == "unified_analysis_enabled":
            cfg.unified_analysis_enabled = _coerce_bool(val)
            continue
        if isinstance(val, str):
            setattr(cfg, field, val.strip())
        elif val is not None:
            setattr(cfg, field, str(val).strip())

    # 重新计算 configured
    cfg.configured = bool(
        cfg.librechat_base_url and cfg.librechat_api_key
        and cfg.has_agent()
    )

    target = _resolve_gateway_file() or (Path(config.PRIVATE_CONFIG_DIR) / "gateway.json")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    payload = {f: getattr(cfg, f) for f in GATEWAY_CONFIG_FIELDS}
    payload["configured"] = cfg.configured
    target.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # 日志只记非敏感摘要（api_key_set 布尔，不记明文）
    log.info("网关配置已更新（文件=%s, api_key_set=%s, mode=%s, unified=%s, m5=%s, m15=%s）",
             target, bool(cfg.librechat_api_key), cfg.analysis_mode(), cfg.unified_agent_id or "-",
             cfg.m5_agent_id or "-", cfg.m15_agent_id or "-")
    return cfg


def _coerce_bool(val) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "on", "y")
    return False
