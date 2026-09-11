"""圆衡 Enkei 外部 AI 终端 - 异步分析任务调度（M1：LibreChat 主链路 + 降级状态机）

- 接收市场摘要后立即入队并返回“已接收”，分析不阻塞圆衡；
- 同一 (symbol, timeframe) 同时最多一个任务；
- 路由优先级（统一分析体）：
    1. LibreChat 指定统一 Agent（无论底层使用云端或本地模型）；
    2. LibreChat 不可用时，才使用已显式配置的云端直连作为受控降级；
    3. 仍失败后，可选转本地 Ollama（90s）；
    4. 本地未安装或不可用 → 保留旧政策并标记 stale/invalid，不伪造结果；
- 健康探测：每 60s 探测一次 LibreChat；连续成功 3 次恢复主路由；
- 每次调用带 request_id，可在日志追踪，绝不泄露密钥或完整敏感提示词。
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Callable

from . import config
from .analysis_audit import store as analysis_audit
from . import gateway as gateway_mod
from . import providers as providers_mod
from . import schemas
from . import security
from . import validator
from .data_quality import market_errors, judgment_errors, timestamp
from .deep_context import fetch_context
from .news import store as news_store
from .policy_store import PolicyStore
from .research import service as research_service

log = logging.getLogger("enkei.terminal")

# 任务 F 默认参数
# LibreChat may front a local reasoning model.  M5/M15 tasks run asynchronously,
# so a 180-second budget does not block quotes and avoids treating normal cold
# starts / reasoning output as a false gateway failure.
M5_ONLINE_TIMEOUT = 180.0     # LibreChat Agent 时限（秒）
LOCAL_FALLBACK_TIMEOUT = 90.0 # 本地备用时限（秒）
PROBE_INTERVAL = 60.0         # 恢复探测间隔（秒）
RECOVER_CONSECUTIVE = 3       # 连续成功次数，达标恢复主路由


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class JobStore:
    def __init__(self):
        self._jobs: dict[str, dict] = {}

    def create(self, symbol: str, tf: str) -> str:
        job_id = uuid.uuid4().hex[:12]
        self._jobs[job_id] = {
            "id": job_id, "symbol": symbol, "timeframe": tf,
            "status": "pending", "created_at": validator.now_iso(),
            "started_at": None, "finished_at": None, "error": None,
            "attempts": 0,
        }
        return job_id

    def get(self, job_id: str) -> dict | None:
        return self._jobs.get(job_id)

    def list(self, limit: int = 50) -> list[dict]:
        rows = sorted(self._jobs.values(), key=lambda j: j.get("created_at", ""), reverse=True)
        return rows[:limit]

    def active_for(self, symbol: str, tf: str) -> bool:
        return any(
            j["symbol"] == symbol and j["timeframe"] == tf
            and j["status"] in ("pending", "running")
            for j in self._jobs.values()
        )

    def mark(self, job_id: str, **kw):
        j = self._jobs.get(job_id)
        if j:
            j.update(kw)


class Scheduler:
    """单 worker 异步分析队列 + LibreChat/Ollama 降级状态机。"""

    def __init__(self, store: PolicyStore, provider_cfg: dict):
        self.store = store
        self.provider_cfg = provider_cfg
        self.gateway_cfg = gateway_mod.load_gateway_config()
        self.jobs = JobStore()
        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._probe_task: asyncio.Task | None = None
        self._done_callback: Callable | None = None
        self.preferred_language = "zh"

        # 路由健康状态机
        self._degraded = "none"          # none / fallback / stale / invalid
        self._consecutive_probe_ok = 0
        self._last_probe_at = 0.0
        self._last_probe_detail = ""

    # ---- 生命周期 ----
    def set_done_callback(self, cb: Callable):
        self._done_callback = cb

    def set_preferred_language(self, language: str) -> str:
        if language in ("zh", "ja", "en"):
            self.preferred_language = language
        return self.preferred_language

    def reload_gateway_config(self, cfg: gateway_mod.GatewayConfig | None = None):
        """热生效：PUT /v1/gateway/config 后立即刷新路由配置。

        传入 cfg 时直接采用（避免重复读盘）；否则重新读取私有配置。
        """
        self.gateway_cfg = cfg if cfg is not None else gateway_mod.load_gateway_config()
        log.info("网关配置已热刷新 librechat_ready=%s mode=%s unified=%s m5=%s m15=%s",
                 self.gateway_cfg.is_librechat_ready(),
                 self.gateway_cfg.analysis_mode(), self.gateway_cfg.unified_agent_id or "-",
                 self.gateway_cfg.m5_agent_id or "-", self.gateway_cfg.m15_agent_id or "-")

    def start(self):
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())
        if self._probe_task is None or self._probe_task.done():
            self._probe_task = asyncio.create_task(self._probe_loop())

    async def stop(self):
        for t in (self._worker, self._probe_task):
            if t and not t.done():
                t.cancel()

    # ---- 健康探测（每 PROBE_INTERVAL 秒，连续 RECOVER_CONSECUTIVE 次成功恢复）----
    async def _probe_loop(self):
        await asyncio.sleep(PROBE_INTERVAL)  # 启动后先不立即探测
        while True:
            ok, detail = await gateway_mod.gateway_probe(self.gateway_cfg)
            self._last_probe_at = time.monotonic()
            self._last_probe_detail = detail
            if ok:
                self._consecutive_probe_ok += 1
                if self._consecutive_probe_ok >= RECOVER_CONSECUTIVE and self._degraded != "none":
                    log.info("LibreChat 恢复探测连续 %d 次成功，恢复主路由 degraded=none", RECOVER_CONSECUTIVE)
                    self._degraded = "none"
                elif self._degraded == "none":
                    self._consecutive_probe_ok = min(self._consecutive_probe_ok, RECOVER_CONSECUTIVE)
            else:
                self._consecutive_probe_ok = 0
                log.warning("LibreChat 健康探测失败: %s", detail)
            await asyncio.sleep(PROBE_INTERVAL)

    def routing_status(self) -> dict:
        """供 /health 与状态接口使用。"""
        return {
            "degraded": self._degraded,
            "consecutive_probe_ok": self._consecutive_probe_ok,
            "last_probe_detail": self._last_probe_detail,
            "librechat_ready": self.gateway_cfg.is_librechat_ready(),
            "local_fallback_enabled": self.gateway_cfg.local_fallback_enabled,
            "analysis_mode": self.gateway_cfg.analysis_mode(),
            "unified_agent": self.gateway_cfg.unified_agent_id,
            "m5_agent": self.gateway_cfg.m5_agent_id,
            "m15_agent": self.gateway_cfg.m15_agent_id,
            "primary_execution": "librechat_agent" if self.gateway_cfg.is_librechat_ready() else "fallback_only",
        }

    # ---- 队列 ----
    async def _run(self):
        while True:
            item = await self._queue.get()
            try:
                await self._process(item)
            except Exception as e:
                log.error("analysis crash: %s", e)
            finally:
                self._queue.task_done()

    def submit(self, market_summary: dict) -> str:
        """入队市场摘要。若同 symbol+tf 已有活动任务，返回现有任务 id 且不重复入队。"""
        symbol = market_summary["symbol"]
        tf = market_summary["timeframe"]
        if self.jobs.active_for(symbol, tf):
            for j in self.jobs.list(200):
                if j["symbol"] == symbol and j["timeframe"] == tf and j["status"] in ("pending", "running"):
                    return j["id"]
        job_id = self.jobs.create(symbol, tf)
        self._queue.put_nowait({"job_id": job_id, "summary": market_summary})
        self.start()
        return job_id

    def reassess(self, market_summary: dict) -> str:
        return self.submit(market_summary)

    # ---- 路由与分析 ----
    def _route(self, tf: str) -> tuple[str, str]:
        """读取本次时间框的提供方与模型角色。"""
        routing = self.provider_cfg.get("routing", {})
        r = routing.get(tf) or routing.get("M5") or {"provider": "ollama", "model_role": "fast"}
        return r.get("provider", "ollama"), r.get("model_role", "fast")

    def _prior_policy_context(self, symbol: str, language: str = "zh") -> str:
        """把 M5/M15 最近有效结论压缩为同一分析体的跨时间框上下文。"""
        rows: list[str] = []
        for timeframe in ("M5", "M15"):
            policy, _ = self.store.get_current(symbol, timeframe)
            if not policy:
                continue
            rationale = policy.get(f"rationale_{language}") or policy.get("rationale_zh", "")
            rows.append(
                f"{timeframe}: {policy.get('action_bias', 'hold')} / "
                f"{policy.get('market_regime', 'unknown')} / "
                f"置信度 {policy.get('confidence', 0)}；"
                f"rationale: {str(rationale)[:180]}"
            )
        if not rows:
            return ""
        return "[Recent cross-timeframe conclusions from the same analyst]\n" + "\n".join(rows)

    async def _route_and_analyze(self, summary: dict, tf: str, news_text: str,
                                 request_id: str) -> tuple[dict, str, str, str]:
        """执行统一分析体与受控降级。返回 (judgment, provider, model_id, degraded)。"""
        # 热生效：每次任务前重新读取私有配置，PUT /v1/gateway/config 无需重启
        self.gateway_cfg = gateway_mod.load_gateway_config()
        self.provider_cfg = config.load_provider_config()
        provider_name, model_role = self._route(tf)

        language = str(summary.get("language") or "zh")
        agent_id = self.gateway_cfg.agent_for(tf)

        # The model explicitly selected in Enkei is authoritative. LibreChat is
        # a durable presentation/audit surface and a fallback inference route;
        # an older Agent model must never silently override the selected route.
        if provider_name != "ollama":
            pcfg = (self.provider_cfg.get("providers") or {}).get(provider_name) or {}
            model_id = (pcfg.get("models") or {}).get(model_role, "")
            timeouts = pcfg.get("timeout_seconds") or {}
            timeout = float(timeouts.get(model_role, 60))
            try:
                provider = providers_mod.build_provider(provider_name, pcfg)
                judgment = await provider.analyze(summary, model_role, timeout, news_text)
                analysis_audit.attempt(request_id, provider=provider_name, model_id=model_id,
                                       route="direct", status="succeeded")
                # The provider selected in routing is the user's primary model,
                # not a degraded result merely because LibreChat was unavailable.
                self._degraded = "none"
                log.info("[%s] 直连云端主路由判断成功 provider=%s model=%s", request_id, provider_name, model_id)
                return judgment, provider_name, model_id, "none"
            except providers_mod.ProviderError as e:
                analysis_audit.attempt(request_id, provider=provider_name, model_id=model_id,
                                       route="direct", status="failed",
                                       error_type=type(e).__name__, error=str(e))
                # 不记录请求头、密钥或完整上游响应；随后尝试统一 Agent。
                log.warning("[%s] 直连提供方失败 provider=%s detail=%s", request_id, provider_name, e)
                self._degraded = "fallback"

        if self.gateway_cfg.is_librechat_ready() and agent_id:
            client = gateway_mod.LibreChatClient(self.gateway_cfg)
            messages = client.build_messages(summary, language=language, news_text=news_text)
            try:
                judgment = await client.ask_agent(agent_id, messages,
                                                  timeout=M5_ONLINE_TIMEOUT, request_id=request_id)
                analysis_audit.attempt(request_id, provider="librechat", model_id=agent_id,
                                       route="librechat_agents_api", status="succeeded")
                degraded = "none" if provider_name in ("ollama", "librechat") else "fallback"
                self._degraded = degraded
                log.info("[%s] 统一 LibreChat Agent 判断成功 agent=%s degraded=%s", request_id, agent_id, degraded)
                return judgment, "librechat", agent_id, degraded
            except gateway_mod.GatewayError as e:
                analysis_audit.attempt(request_id, provider="librechat", model_id=agent_id,
                                       route="librechat_agents_api", status="failed",
                                       error_type=e.category, error=e.message)
                log.warning("[%s] 统一 LibreChat Agent 失败 category=%s msg=%s", request_id, e.category, e.message)
                if not self.gateway_cfg.local_fallback_enabled and provider_name == "ollama":
                    self._degraded = "stale"
                    raise providers_mod.ProviderError(f"librechat:{e.category}")
                self._degraded = "fallback"

        if provider_name == "ollama" and self.gateway_cfg.configured:
            if not self.gateway_cfg.local_fallback_enabled:
                raise providers_mod.ProviderError("librechat:not_ready")
            self._degraded = "fallback"

        # 本地 Ollama 备用
        pcfg = (self.provider_cfg.get("providers") or {}).get("ollama") or {}
        fallback_model = self.gateway_cfg.ollama_fallback_model
        if fallback_model:
            pcfg = dict(pcfg)
            pcfg["models"] = dict((pcfg.get("models") or {}))
            pcfg["models"]["deep"] = fallback_model
            pcfg["models"]["fast"] = fallback_model
        try:
            provider = providers_mod.build_provider("ollama", pcfg)
            judgment = await provider.analyze(summary, "deep", LOCAL_FALLBACK_TIMEOUT, news_text)
            model_id = fallback_model or (pcfg.get("models") or {}).get("deep", "deepseek-r1:7b")
            analysis_audit.attempt(request_id, provider="ollama", model_id=model_id,
                                   route="local_ollama", status="succeeded")
            self._degraded = "fallback"
            log.info("[%s] 本地 Ollama 备用判断成功 model=%s", request_id, model_id)
            return judgment, "ollama", model_id, "fallback"
        except providers_mod.ProviderError as e:
            analysis_audit.attempt(request_id, provider="ollama", model_id=fallback_model,
                                   route="local_ollama", status="failed",
                                   error_type=type(e).__name__, error=str(e))
            # 本地也不可用：不伪造结果，由上层标记 stale/invalid
            log.error("[%s] 本地 Ollama 备用失败: %s", request_id, e)
            raise

    async def _process(self, item: dict):
        job_id = item["job_id"]
        summary = item["summary"]
        summary["language"] = str(summary.get("language") or self.preferred_language)
        symbol = summary["symbol"]
        tf = summary["timeframe"]
        self.jobs.mark(job_id, status="running", started_at=validator.now_iso())
        request_id = f"req_{uuid.uuid4().hex[:12]}"
        self.provider_cfg = config.load_provider_config()
        requested_provider, requested_role = self._route(tf)
        requested_cfg = (self.provider_cfg.get("providers") or {}).get(requested_provider) or {}
        requested_model = (requested_cfg.get("models") or {}).get(requested_role, "")

        errors = market_errors(summary)
        if errors:
            analysis_audit.submitted(request_id, summary, agent_id="", context={"validation_errors": errors[:5]},
                                     requested_provider=requested_provider, requested_model=requested_model,
                                     route="validation", submitted_to_model=False)
            analysis_audit.finished(request_id, status="rejected", error="; ".join(errors[:5]))
            self.jobs.mark(job_id, status="failed", finished_at=validator.now_iso(),
                           error="行情质量校验失败: " + "; ".join(errors[:3]), request_id=request_id, degraded="stale")
            return
        # 数据先进入共享研究缓存，不能等模型成功才提供行情。
        await research_service.observe_market(summary)

        language = str(summary.get("language") or "zh")
        news_items = await news_store.relevant_items(symbol, limit=3, language=language)
        news_context = [
            " | ".join(
                part for part in (
                    it.get("display_title") or it.get("title", ""),
                    it.get("ai_summary", ""),
                    it.get("relevance", ""),
                ) if part
            )
            for it in news_items
            if it.get("title")
        ]
        research_details = await research_service.context_details_for(symbol)
        research_context = str(research_details.get("context") or "")
        deep_context = await fetch_context(symbol, tf)
        context_blocks = [research_context, deep_context, self._prior_policy_context(symbol, language), "\n".join(f"- {text[:800]}" for text in news_context)]
        news_text = "\n\n".join(block for block in context_blocks if block)
        if news_context:
            log.info("[%s] 本次判断附带 %d 条新闻上下文", request_id, len(news_context))
        if research_context:
            log.info("[%s] 本次判断附带有效市场专项追踪上下文", request_id)

        # 这是对 LibreChat 无状态 Agent 请求的可查看证据链，而不是伪造其网页聊天记录。
        # 仅记录数量、标题和摘要摘要；完整提示词、账户信息与任何密钥都不落盘。
        analysis_audit.submitted(
            request_id,
            summary,
            agent_id=self.gateway_cfg.agent_for(tf),
            context={
                "news_count": len(news_context),
                "news_titles": [(it.get("display_title") or it.get("title", ""))[:180] for it in news_items[:3]],
                "research_context": bool(research_context),
                "research_report_id": research_details.get("report_id"),
                "research_generated_at": research_details.get("generated_at"),
                "research_valid_until": research_details.get("valid_until"),
                "deep_research_context": bool(deep_context),
                "prior_policy_context": bool(self._prior_policy_context(symbol, language)),
                "language": language,
                "context_characters": len(news_text),
            },
            requested_provider=requested_provider,
            requested_model=requested_model,
            display_name=requested_model,
            route="direct" if requested_provider != "ollama" else "local_ollama",
        )

        # ---- 分析（LibreChat 优先 + 可选 Ollama 降级） ----
        judgment = None
        last_error = None
        source = ""
        model_id = ""
        degraded = "none"
        try:
            judgment, source, model_id, degraded = await self._route_and_analyze(
                summary, tf, news_text, request_id)
        except providers_mod.ProviderError as e:
            last_error = str(e)

        # JSON 解析失败等场景做 1 次修复重试（总 2 次），仅对成功链路重试
        if judgment is None:
            # 判定为 stale / invalid：保留旧政策，记录失败原因
            stale = self.store.get_any(symbol, tf)
            if stale is not None:
                self._degraded = "stale"
                self.jobs.mark(job_id, status="failed", finished_at=validator.now_iso(),
                               error=last_error or "未知错误", attempts=1,
                               request_id=request_id, degraded="stale")
                log.error("[%s] 分析失败，保留旧政策(stale): %s", request_id, last_error)
            else:
                self._degraded = "invalid"
                self.jobs.mark(job_id, status="failed", finished_at=validator.now_iso(),
                               error=last_error or "未知错误", attempts=1,
                               request_id=request_id, degraded="invalid")
                log.error("[%s] 分析失败，无旧政策(invalid): %s", request_id, last_error)
            analysis_audit.finished(request_id, status="failed", error=last_error or "unknown_error",
                                    error_type="provider_exhausted", degraded=True,
                                    degrade_reason=last_error or "all_routes_failed")
            return

        token_usage = judgment.pop("_usage", None)
        judgment.pop("_latency_ms", None)
        judgment.pop("_request_id", None)

        errors = judgment_errors(judgment)
        if errors:
            analysis_audit.finished(request_id, status="invalid", error="; ".join(errors))
            self.jobs.mark(job_id, status="failed", finished_at=validator.now_iso(),
                           error="模型内容校验失败: " + "; ".join(errors), request_id=request_id, degraded="invalid")
            return
        # 审计保存本次实际注入的研究，不再仅记录新闻标题。
        if research_context:
            news_context.append(research_context)
        if deep_context:
            news_context.append(deep_context)
        # 填充元数据并校验
        policy = validator.build_policy(summary, judgment, source, model_id, model_version=model_id,
                                        news_context=news_context, source=source,
                                        degraded=degraded, request_id=request_id)
        errors = schemas.validate_output(policy)
        if timestamp(policy["expires_at"]) <= datetime.now(timezone.utc):
            errors.append("模型完成时输入行情已超出本周期 TTL，需要最新数据重算")
        if errors:
            self._degraded = "invalid"
            self.jobs.mark(job_id, status="failed", finished_at=validator.now_iso(),
                           error=f"输出校验失败: {'；'.join(errors[:3])}", attempts=1,
                           request_id=request_id, degraded="invalid")
            log.error("[%s] 输出校验失败: %s", request_id, errors[:3])
            analysis_audit.finished(request_id, status="invalid", error="; ".join(errors[:3]))
            return

        etag = self.store.put(policy)
        self.jobs.mark(job_id, status="succeeded", finished_at=validator.now_iso(), attempts=1,
                       request_id=request_id, degraded=degraded, source=source)
        actual_route = "librechat_agents_api" if source == "librechat" else ("local_ollama" if source == "ollama" else "direct")
        analysis_audit.finished(request_id, status="succeeded", result={
            "source": source,
            "model_id": model_id,
            "degraded": degraded,
            "policy_id": policy.get("id"),
            "action_bias": policy.get("action_bias"),
            "confidence": policy.get("confidence"),
            "expires_at": policy.get("expires_at"),
            "rationale_zh": policy.get("rationale_zh"),
            "rationale_ja": policy.get("rationale_ja"),
            "rationale_en": policy.get("rationale_en"),
            "token_usage": token_usage,
        }, actual_provider=source, actual_model_id=model_id, route=actual_route,
           degraded=degraded != "none", degrade_reason=None if degraded == "none" else "primary_route_failed",
           local_fallback_used=source == "ollama" and requested_provider != "ollama")
        log.info("[%s] 政策已生成 %s/%s etag=%s source=%s degraded=%s regime=%s bias=%s conf=%s",
                 request_id, symbol, tf, etag, source, degraded,
                 policy["market_regime"], policy["action_bias"], policy["confidence"])
        if self._done_callback:
            try:
                self._done_callback(policy)
            except Exception:
                pass
