"""圆衡 Enkei 外部 AI 终端 - FastAPI 入口

仅绑定 127.0.0.1。接口见 外部AI终端任务书.md：
- GET  /health
- POST /v1/assessments
- GET  /v1/policies/current
- GET  /v1/jobs
- GET  /v1/policies/history
- POST /v1/reassess
"""
from __future__ import annotations

import logging
import json
import logging.handlers
import sys
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import config
from .analysis_audit import store as analysis_audit
from .api_guard import ApiGuardMiddleware
from . import gateway as gateway_mod
from . import news as news_mod
from . import providers as providers_mod
from . import research as research_mod
from . import schemas
from . import validator
from .evaluator import LedgerError, LedgerStore
from .learning import LearningCenter
from .policy_store import PolicyStore
from .scheduler import Scheduler

_terminal_log_handler = logging.handlers.RotatingFileHandler(
    config.LOG_FILE, encoding="utf-8", maxBytes=5 * 1024 * 1024, backupCount=3)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[_terminal_log_handler, logging.StreamHandler(sys.stdout)],
)


class _DropClientResetNoise(logging.Filter):
    """丢弃 Windows Proactor 回收已断开客户端连接时的 ConnectionResetError 回溯噪音。

    浏览器每秒轮询后断开属正常行为，不是服务故障；真实错误仍会完整记录。
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name.startswith("asyncio") and record.exc_info and record.exc_info[1] is not None:
            return "ConnectionResetError" not in type(record.exc_info[1]).__name__
        return True


logging.getLogger("asyncio").addFilter(_DropClientResetNoise())
# 第三方库噪音日志降级
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
log = logging.getLogger("enkei.terminal")

store: PolicyStore | None = None
scheduler: Scheduler | None = None
ledger: LedgerStore | None = None
learning: LearningCenter | None = None
provider_cfg: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, scheduler, ledger, learning, provider_cfg
    provider_cfg = config.load_provider_config()
    store = PolicyStore()
    ledger = LedgerStore()
    learning = LearningCenter(ledger)
    scheduler = Scheduler(store, provider_cfg)
    scheduler.start()
    # An abnormal-price research report is immediately fed back through the
    # same validated policy queue once. observe_market updates its baseline
    # before invoking this callback, preventing a self-trigger loop.
    research_mod.service.configure(store, urgent_callback=scheduler.reassess)
    await research_mod.service.start()
    await news_mod.store.start()  # 启动 RSS 新闻刷新（失败静默降级）
    log.info("外部 AI 终端已启动 host=%s port=%s", config.HOST, config.PORT)
    yield
    if scheduler and scheduler._worker:
        scheduler._worker.cancel()
    await research_mod.service.stop()
    await news_mod.store.stop()


app = FastAPI(title="Enkei AI Terminal", version="0.1.0", lifespan=lifespan)

# The terminal binds to loopback only, but the Enkei panel runs on a separate
# loopback port.  Allow just those panel origins so the browser can read and
# save the local routing configuration; do not open this service to LAN hosts.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "If-None-Match", "Idempotency-Key"],
)

# 纵深防御：限流 + 请求体上限 + 写操作审计（见 api_guard.py）。
# 审计只记 时间/方法/路径/状态码/来源端口，不记录请求体。
app.add_middleware(ApiGuardMiddleware, audit_path=config.AUDIT_DIR / "api-mutations.jsonl")


@app.get("/health")
async def health():
    ollama_cfg = provider_cfg.get("providers", {}).get("ollama", {})
    ollama = await providers_mod.ollama_health(ollama_cfg.get("base_url", "http://127.0.0.1:11434"))
    running = sum(1 for j in scheduler.jobs.list(500) if j["status"] in ("pending", "running"))
    return {
        "service": "ok",
        "version": "enkei-ai-terminal/0.1.0",
        "host": f"{config.HOST}:{config.PORT}",
        "ollama": ollama,
        "gateway": scheduler.routing_status(),
        "routing": provider_cfg.get("routing", {}),
        "jobs": {"active": running, "total": len(scheduler.jobs.list(1000))},
        "policies": len(store.all_latest()),
        "research": await research_mod.service.status(),
    }


@app.post("/v1/assessments")
async def submit_assessment(payload: dict):
    from .data_quality import market_errors
    errors = market_errors(payload)
    if errors:
        # 即使被入口质量门拒绝，也留下脱敏记录，方便用户知道“没有送往模型”。
        import uuid
        request_id = f"req_{uuid.uuid4().hex[:12]}"
        analysis_audit.submitted(request_id, payload, agent_id="", context={"validation_errors": errors[:5]},
                                 route="validation", submitted_to_model=False)
        analysis_audit.finished(request_id, status="rejected", error="; ".join(errors[:5]))
        raise HTTPException(status_code=422, detail={"error": "market_summary_invalid", "details": errors[:5]})
    # M1 防呆 A2：AI 终端拒绝 M1 提交（主程序侧 A1 也不提交 M1）
    if payload.get("timeframe") == "M1":
        raise HTTPException(status_code=422, detail={
            "error": "timeframe_not_supported",
            "detail": "M1 周期不参与 AI 评估，请使用 M5/M15（评估回环 v1.4.0 契约）",
        })
    await research_mod.service.observe_market(payload)
    job_id = scheduler.submit(payload)
    return JSONResponse(status_code=202, content={"status": "accepted", "task_id": job_id,
                                                  "symbol": payload["symbol"],
                                                  "timeframe": payload["timeframe"]})


@app.get("/v1/policies/current")
async def get_current(
    symbol: str = Query(..., pattern="^[A-Z]{6}$"),
    timeframe: str = Query(..., pattern="^(M1|M5|M15)$"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
):
    policy, etag = store.get_current(symbol, timeframe)
    if policy is None:
        # 有值但已过期 / 从未生成
        stale = store.get_any(symbol, timeframe)
        if stale:
            raise HTTPException(status_code=404, detail={"status": "no_valid_policy",
                                                         "reason": "expired",
                                                         "stale_expires_at": stale.get("expires_at")})
        raise HTTPException(status_code=404, detail={"status": "no_valid_policy", "reason": "none"})
    headers = {"ETag": etag}
    if if_none_match and if_none_match.strip() == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=policy, headers=headers)


@app.get("/v1/jobs")
async def list_jobs(limit: int = Query(default=50, ge=1, le=200)):
    return {"jobs": scheduler.jobs.list(limit)}


@app.get("/v1/audit/analysis")
async def analysis_traces(
    symbol: str | None = Query(default=None, pattern="^[A-Z]{6}$"),
    limit: int = Query(default=30, ge=1, le=100),
):
    """返回统一分析体的脱敏请求链路，供圆衡界面核对真实提交与结果。"""
    return {"traces": analysis_audit.list(symbol=symbol, limit=limit)}


@app.get("/v1/usage")
async def token_usage():
    """Return provider-reported token counts only; no inferred or fabricated usage."""
    return analysis_audit.usage_summary()


@app.put("/v1/preferences/language")
async def set_preferred_language(payload: dict):
    language = str(payload.get("language") or "")
    if language not in ("zh", "ja", "en"):
        raise HTTPException(status_code=422, detail="language must be zh, ja, or en")
    return {"language": scheduler.set_preferred_language(language)}


@app.get("/v1/policies/history")
async def policy_history(
    symbol: str = Query(..., pattern="^[A-Z]{6}$"),
    timeframe: str = Query(..., pattern="^(M1|M5|M15)$"),
    limit: int = Query(default=50, ge=1, le=200),
):
    return {"history": store.history(symbol, timeframe, limit)}


@app.post("/v1/reassess")
async def reassess(payload: dict):
    symbol = payload.get("symbol", "")
    tf = payload.get("timeframe", "")
    if not (isinstance(symbol, str) and len(symbol) == 6 and symbol.isupper()):
        raise HTTPException(status_code=422, detail="symbol 需为 6 位大写，如 USDJPY")
    if tf not in ("M5", "M15"):
        raise HTTPException(status_code=422, detail="timeframe 需为 M5/M15")
    summary = research_mod.service.latest_packet(symbol, tf)
    if summary is None:
        raise HTTPException(status_code=409, detail="缺少新鲜行情摘要，请恢复行情推流后重新评估；不会以空报价代替行情。")
    job_id = scheduler.reassess(summary)
    return JSONResponse(status_code=202, content={"status": "accepted", "task_id": job_id})


# ============ v1.4.0 评估回环端点 ============

def _require_ledger() -> LedgerStore:
    if ledger is None:
        raise HTTPException(status_code=503, detail="台账未初始化")
    return ledger


def _policy_version() -> str:
    return "enkei-ai-feedback/v2"


@app.post("/v1/events/decision")
async def add_decision_event(payload: dict):
    """主程序上报决策事件（是否采用 AI 政策），按 event_id 幂等。"""
    if payload.get("type") not in (None, "decision"):
        raise HTTPException(status_code=422, detail={"error": "type_mismatch", "detail": "本端点仅接收 decision 事件"})
    try:
        result = _require_ledger().add_decision(payload)
    except LedgerError as e:
        raise HTTPException(status_code=422, detail={"error": "event_invalid", "detail": str(e)})
    return JSONResponse(status_code=202 if result["status"] == "recorded" else 200, content=result)


@app.post("/v1/events/outcome")
async def add_outcome_event(payload: dict):
    """主程序上报结果事件（政策最终盈亏），按 event_id 幂等。"""
    if payload.get("type") not in (None, "outcome"):
        raise HTTPException(status_code=422, detail={"error": "type_mismatch", "detail": "本端点仅接收 outcome 事件"})
    try:
        result = _require_ledger().add_outcome(payload)
    except LedgerError as e:
        raise HTTPException(status_code=422, detail={"error": "event_invalid", "detail": str(e)})
    return JSONResponse(status_code=202 if result["status"] == "recorded" else 200, content=result)


@app.get("/v1/ledger")
async def ledger_query(
    symbol: str | None = Query(default=None, pattern="^[A-Z]{6}$"),
    timeframe: str | None = Query(default=None, pattern="^(M1|M5|M15)$"),
    event_type: str | None = Query(default=None, pattern="^(decision|outcome)$"),
    limit: int = Query(default=200, ge=1, le=1000),
):
    return {"events": _require_ledger().query(symbol, timeframe, event_type, limit)}


@app.get("/v1/ledger/summary")
async def ledger_summary():
    return _require_ledger().summary()


def _require_learning() -> LearningCenter:
    if learning is None:
        raise HTTPException(status_code=503, detail="学习中心未初始化")
    return learning


@app.get("/v1/learning/dashboard")
async def learning_dashboard(
    limit: int = Query(default=50, ge=1, le=200),
    environment: str = Query(default="all", pattern="^(all|demo|live|unknown)$"),
    lifecycle: str = Query(default="all", pattern="^(all|completed|rejected|awaiting_outcome)$"),
):
    return _require_learning().dashboard(limit, environment, lifecycle)


@app.get("/v1/learning/control")
async def learning_control():
    return _require_learning().control()


@app.post("/v1/learning/proposals")
async def learning_proposal():
    center = _require_learning()
    try:
        proposal = center.propose()
        if proposal.get("status") != "awaiting_ai_review":
            return proposal
        request_id = f"learn_{uuid.uuid4().hex[:12]}"
        evidence = [{key: item.get(key) for key in ("condition_key", "condition", "samples", "direction_accuracy", "net_pnl", "risk", "strategies", "changes")}
                    for item in proposal.get("conditional_proposals", [])[:12]]
        messages = [
            {"role": "system", "content": (
                "你是圆衡AI学习中心的策略权重审查员。只输出合法JSON。你不能直接改策略，只能依据给定的闭环样本提出建议。"
                "必须同时考虑市场状态、周期、时段、新闻环境、AI与本地策略一致性、入场退出、点差、滑点、盈亏、样本可信度、最大回撤和连续亏损。"
                "不得引用输入以外的数据，不得增加未知策略或条件。recommendations每项必须包含condition_key、changes、why、expected_improvement、"
                "do_not_apply_when、confidence、sample_reliability、evidence_summary。changes格式为策略名到delta数值。")},
            {"role": "user", "content": json.dumps({"task": "conditional_weight_review", "proposal_id": proposal["id"],
                "active_version": center.control()["active"].get("version"), "constraints": proposal.get("constraints"),
                "evidence": evidence, "required_output": {"summary": "string", "risks": ["string"], "recommendations": ["structured items"]}},
                ensure_ascii=False)},
        ]
        gateway_cfg = gateway_mod.load_gateway_config()
        agent_id = gateway_cfg.agent_for("M15")
        identity = {"request_id": request_id, "route": "librechat_agents_api", "provider": "librechat",
                    "model_id": None, "agent_id": agent_id, "degraded": False}
        if gateway_cfg.is_librechat_ready() and agent_id:
            review = await gateway_mod.LibreChatClient(gateway_cfg).ask_agent(agent_id, messages, timeout=120.0, request_id=request_id)
            identity["model_id"] = str(review.get("_model_id") or "unknown-via-agent")
        else:
            latest = config.load_provider_config()
            route = (latest.get("routing") or {}).get("M15") or {}
            provider_name = str(route.get("provider") or "")
            role = str(route.get("model_role") or "deep")
            provider_settings = (latest.get("providers") or {}).get(provider_name) or {}
            if not provider_name or provider_name == "ollama":
                raise ValueError("统一分析体未配置可用于权重审查的在线模型")
            provider = providers_mod.build_provider(provider_name, provider_settings)
            review = await provider.analyze_messages(messages, role, 120.0, max_tokens=2600)
            identity = {"request_id": request_id, "route": "provider_direct", "provider": provider_name,
                        "model_id": str((provider_settings.get("models") or {}).get(role) or "unknown"),
                        "agent_id": None, "degraded": False}
        return center.apply_ai_review(proposal["id"], review, identity)
    except ValueError as exc:
        if 'proposal' in locals() and proposal.get("status") == "awaiting_ai_review":
            return center.fail_ai_review(proposal["id"], str(exc), locals().get("identity"))
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.warning("AI权重建议生成失败: %s", exc)
        if 'proposal' in locals() and proposal.get("status") == "awaiting_ai_review":
            return center.fail_ai_review(proposal["id"], str(exc), locals().get("identity"))
        raise HTTPException(status_code=503, detail="AI权重建议生成失败")


@app.post("/v1/learning/proposals/{proposal_id}/confirm")
async def learning_confirm(proposal_id: str, payload: dict):
    try: return _require_learning().confirm(proposal_id, payload.get("confirmation"))
    except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc))


@app.post("/v1/learning/candidate/activate")
async def learning_activate(payload: dict):
    try: return _require_learning().activate(payload.get("confirmation"))
    except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc))


@app.post("/v1/learning/rollback")
async def learning_rollback(payload: dict):
    try: return _require_learning().rollback(payload.get("confirmation"))
    except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc))


@app.put("/v1/learning/settings")
async def learning_settings(payload: dict):
    try: return _require_learning().settings(payload)
    except (TypeError, ValueError) as exc: raise HTTPException(status_code=422, detail=str(exc))


@app.post("/v1/learning/archive")
async def learning_archive():
    return _require_learning().archive()


@app.get("/v1/learning/export")
async def learning_export():
    return _require_learning().export()


@app.post("/v1/learning/cleanup")
async def learning_cleanup(payload: dict):
    try: return _require_learning().cleanup(payload.get("confirmation"))
    except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc))


@app.post("/v1/learning/restore")
async def learning_restore(payload: dict):
    try: return _require_learning().restore_latest(payload.get("confirmation"))
    except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc))


@app.get("/v1/news")
async def list_news(
    symbol: str = Query(default="", pattern="^[A-Z]{0,6}$"),
    limit: int = Query(default=30, ge=1, le=100),
    language: str = Query(default="zh", pattern="^(zh|ja|en)$"),
):
    """新闻池：不带 symbol 返回全量（含来源状态）；带 symbol 返回与该货币对相关的新闻。

    language 用于按当前界面语言标注翻译状态（original/pending/translated），
    初期本地规则不调用付费 API，英文新闻保留原文并标记 pending。
    新闻抓取失败只影响本端点，不会影响行情 / AI 分析 / Demo。
    """
    if symbol:
        items = await news_mod.store.relevant_items(symbol, limit, language)
        data = await news_mod.store.list_all(limit, language)
        data["items"] = items
        data["total"] = len(items)
        data["symbol"] = symbol
        return data
    return await news_mod.store.list_all(limit, language)


@app.get("/v1/news/sources")
async def news_sources():
    """可替换 RSS 新闻源清单 + 每个源的抓取状态（v1.6.0）。

    返回每个源 ok / last_refresh / last_error / last_count；
    体验者可用 PUT /v1/news/sources 替换为自有 RSS 源，无需改代码。
    """
    data = await news_mod.store.list_all(1)
    return {"sources": data["sources"], "auto_sources": data["auto_sources"], "last_refresh": data["last_refresh"], "last_error": data["last_error"]}


@app.put("/v1/news/sources")
async def replace_news_sources(payload: dict):
    """替换 RSS 源清单（体验者配置；重启或刷新后生效）。

    入参：{"sources": [{"name": "my-source", "url": "https://..."}]}
    最多保留 12 个源；非法项自动过滤，空清单回退默认源。
    """
    raw = payload.get("sources")
    if not isinstance(raw, list):
        raise HTTPException(status_code=422, detail="sources 必须是数组")
    sources = await news_mod.store.set_sources(raw)
    return {"status": "ok", "sources": sources}


@app.post("/v1/news/refresh")
async def refresh_news():
    """手动触发一次 RSS 抓取（前端“刷新”按钮）。

    单源失败只标记该源状态；所有源均失败时返回失败原因，且不影响其它模块。
    """
    await news_mod.store.refresh_once()
    data = await news_mod.store.list_all(10)
    # ok 字段供前端判定“本次刷新已执行完成”（即使个别源失败也已完成一次抓取）；
    # last_error 描述具体失败来源，不影响前端将本次刷新视为成功。
    return {"status": "ok", "ok": True, "last_refresh": data["last_refresh"], "last_error": data["last_error"],
            "sources": data["sources"], "total": data["total"]}


@app.post("/v1/news")
async def inject_news(payload: dict):
    """手动注入一条市场新闻（外网不可达或补充专属消息时使用）。"""
    title = str(payload.get("title", "")).strip()[:200]
    if not title:
        raise HTTPException(status_code=422, detail="title 不能为空")
    body = str(payload.get("body", ""))[:4000]
    source = str(payload.get("source", "manual"))[:40]
    await news_mod.store.inject(title, body, source)
    return {"status": "ok", "injected": title[:80], "source": source}


@app.get("/v1/news/status")
async def news_status():
    """新闻上下文接入状态（v1.4.0）。"""
    return {
        "module": "news.py",
        "enabled": True,
        "channel": "RSS 自动抓取(fxstreet/yahoo/forexlive) + POST /v1/news 手动注入",
        "max_items": 10,
        "note": "按货币对过滤相关新闻后注入判断提示词，并随 v2 政策写入 news_context（最多10条）",
    }


# ============ 市场专项追踪：持久研究记忆库 ============

@app.get("/v1/research/status")
async def research_status():
    return await research_mod.service.status()


@app.get("/v1/research/topics")
async def research_topics():
    return {"topics": await research_mod.service.topics()}


@app.post("/v1/research/topics")
async def create_research_topic(payload: dict):
    try:
        topic = await research_mod.service.upsert_topic(payload)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return JSONResponse(status_code=201, content={"status": "created", "topic": topic})


@app.put("/v1/research/topics/{topic_id}")
async def update_research_topic(topic_id: str, payload: dict):
    try:
        topic = await research_mod.service.upsert_topic(payload, topic_id)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"status": "updated", "topic": topic}


@app.delete("/v1/research/topics/{topic_id}")
async def delete_research_topic(topic_id: str):
    if not await research_mod.service.delete_topic(topic_id):
        raise HTTPException(status_code=404, detail="未找到研究专题")
    return {"status": "deleted", "topic_id": topic_id}


@app.post("/v1/research/topics/{topic_id}/run")
async def run_research_topic(topic_id: str, payload: dict | None = None):
    try:
        body = payload or {}
        report = await research_mod.service.run_topic(
            topic_id,
            str(body.get("trigger") or "manual"),
            str(body.get("language") or "") or None,
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        log.exception("市场专项追踪生成失败 topic=%s", topic_id)
        raise HTTPException(status_code=502, detail="专题生成失败；未写入策略上下文，请检查终端日志后重试")
    return {"status": "ok", "report": report}


@app.get("/v1/research/reports")
async def research_reports(
    symbol: str | None = Query(default=None, pattern="^[A-Z0-9]{3,12}$"),
    limit: int = Query(default=20, ge=1, le=100),
):
    return {"reports": await research_mod.service.reports(symbol, limit)}


@app.get("/v1/research/triggers")
async def research_triggers(
    symbol: str | None = Query(default=None, pattern="^[A-Z0-9]{3,12}$"),
    limit: int = Query(default=50, ge=1, le=200),
):
    return {"triggers": await research_mod.service.triggers(symbol, limit)}


@app.get("/v1/research/context")
async def research_context(symbol: str = Query(..., pattern="^[A-Z0-9]{3,12}$")):
    context = await research_mod.service.context_for(symbol)
    # Keep the original text field for existing clients and expose an explicit
    # boolean so monitors do not mistake a valid non-empty context for failure.
    return {"symbol": symbol, "context": context, "has_context": bool(context)}


# ============ M1：LibreChat 统一模型入口 端点 ============

@app.get("/v1/models")
async def list_models(
    sort: str = Query(default="provider", pattern="^(provider|deployment|availability|price|compute|latency)$"),
):
    """任务 C：模型/Agent 目录接口。

    返回三层：
    - available_agents：LibreChat 已配置且可用的决策 Agent + 本机 Ollama 已安装模型；
    - known_providers：已知但尚未配置的提供商提示（available=false，不显示为可调用）；
    - 明确区分“可选模型”与“已配置、可直接用于圆衡判断的 Agent”（configured / configured_by）。
    """
    cfg = gateway_mod.load_gateway_config()
    catalog = await gateway_mod.collect_model_catalog(cfg)
    catalog = gateway_mod.sort_catalog(catalog, sort)
    return catalog


@app.post("/v1/gateway/test")
async def gateway_test(payload: dict):
    """任务 D：Provider/Agent 测试接口。

    输入（二选一）：
      {"agent": "<agent_id>"}   测试 LibreChat 决策 Agent；
      {"model": "<model_name>"} 测试本机 Ollama 本地模型。
    行为：检查 URL/认证/存在性 → 发起一次最小结构化 JSON 请求。
    返回 ok / latency_ms / model_or_agent / source / json_valid / failure_category。
    绝不回传密钥、完整请求头或供应商原始敏感错误。
    """
    agent = str(payload.get("agent") or "").strip()
    model = str(payload.get("model") or "").strip()
    if bool(agent) == bool(model):
        raise HTTPException(status_code=422, detail="请提供且仅提供 agent 或 model 之一")
    cfg = gateway_mod.load_gateway_config()

    if agent:
        if not cfg.librechat_base_url or not cfg.librechat_api_key:
            raise HTTPException(status_code=503, detail={
                "ok": False, "failure_category": "not_configured",
                "detail": "LibreChat 未配置，无法测试 Agent",
            })
        client = gateway_mod.LibreChatClient(cfg)
        # 1) 存在性检查
        try:
            known = await client.list_agents()
        except gateway_mod.GatewayError as e:
            raise HTTPException(status_code=502, detail={
                "ok": False, "source": "librechat", "model_or_agent": agent,
                "latency_ms": None, "json_valid": False, "failure_category": e.category,
                "detail": e.message,
            })
        ids = {it.get("id") or it.get("model") for it in known}
        if agent not in ids:
            raise HTTPException(status_code=404, detail={
                "ok": False, "source": "librechat", "model_or_agent": agent,
                "latency_ms": None, "json_valid": False, "failure_category": "agent_not_found",
                "detail": f"Agent {agent} 未在 LibreChat 中配置或不可访问",
            })
        # 2) 最小 JSON 请求
        try:
            result = await client.test_agent(agent)
        except gateway_mod.GatewayError as e:
            raise HTTPException(status_code=502, detail={
                "ok": False, "source": "librechat", "model_or_agent": agent,
                "latency_ms": None, "json_valid": False, "failure_category": e.category,
                "detail": e.message,
            })
        return {
            "ok": result["ok"], "latency_ms": result["latency_ms"],
            "model_or_agent": agent, "source": "librechat",
            "json_valid": result["json_valid"], "failure_category": "none",
        }

    # Ollama 本地模型测试
    base = cfg.ollama_base_url or "http://127.0.0.1:11434"
    health = await providers_mod.ollama_health(base)
    if not health.get("ok"):
        raise HTTPException(status_code=502, detail={
            "ok": False, "source": "ollama", "model_or_agent": model,
            "latency_ms": None, "json_valid": False,
            "failure_category": "unreachable", "detail": "本机 Ollama 不可达",
        })
    installed = {m for m in health.get("models", [])}
    if model not in installed:
        raise HTTPException(status_code=404, detail={
            "ok": False, "source": "ollama", "model_or_agent": model,
            "latency_ms": None, "json_valid": False,
            "failure_category": "model_not_found",
            "detail": f"本地 Ollama 未安装模型 {model}",
        })
    from .providers import build_provider
    pcfg = (provider_cfg.get("providers") or {}).get("ollama") or {}
    pcfg = dict(pcfg)
    pcfg["models"] = dict((pcfg.get("models") or {}))
    pcfg["models"]["fast"] = model
    pcfg["models"]["deep"] = model
    provider = build_provider("ollama", pcfg)
    try:
        started = time.monotonic()
        judgment = await provider.analyze({}, "deep", 90.0, "")
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "ok": True, "latency_ms": latency_ms,
            "model_or_agent": model, "source": "ollama",
            "json_valid": isinstance(judgment, dict), "failure_category": "none",
        }
    except providers_mod.ProviderError as e:
        raise HTTPException(status_code=502, detail={
            "ok": False, "source": "ollama", "model_or_agent": model,
            "latency_ms": None, "json_valid": False,
            "failure_category": "invalid_json", "detail": str(e),
        })


@app.get("/v1/gateway/config")
async def get_gateway_config():
    """任务补充：GET 脱敏网关配置。

    返回字段：librechat_base_url / api_key_set / m5_agent_id / m15_agent_id /
    local_fallback_enabled / ollama_base_url / ollama_fallback_model / configured。
    绝不回传 librechat_api_key 明文（仅 api_key_set 布尔）。
    供圆衡主程序完成 M5/M15 Agent 选择与热生效，不重复保存供应商密钥。
    """
    return gateway_mod.masked_gateway_config()


@app.put("/v1/gateway/config")
async def put_gateway_config(payload: dict):
    """任务补充：PUT 更新网关配置（部分更新，热生效）。

    可写字段：librechat_base_url / librechat_api_key / m5_agent_id / m15_agent_id /
    local_fallback_enabled / ollama_base_url / ollama_fallback_model。
    约束：
    - API Key 仅在显式提交且非空时写入，GET/日志绝不回传明文；
    - 仅更新 payload 中出现的字段，其余保留；
    - local_fallback_enabled 接受 bool 或 'true'/'false'/'1'/'0'。
    返回脱敏后的最新配置。
    """
    unknown = set(payload) - set(gateway_mod.GATEWAY_CONFIG_FIELDS)
    if unknown:
        raise HTTPException(status_code=422, detail={
            "error": "unknown_field", "fields": sorted(unknown),
        })
    try:
        cfg = gateway_mod.save_gateway_config(payload)
    except Exception as e:
        log.error("网关配置写入失败: %s", e)
        raise HTTPException(status_code=500, detail={"error": "save_failed", "detail": "配置写入失败"})
    if scheduler is not None:
        scheduler.reload_gateway_config(cfg)
    return gateway_mod.masked_gateway_config(cfg)


# ============ 批B：直连路由（providers.json routing/models 读写） ============

_ROUTING_PROVIDERS = {"ollama", "deepseek", "openai", "qwen", "zhipu", "gemini", "minimax", "groq", "openrouter", "custom"}
_ROUTING_TFS = ("M5", "M15")
_ROUTING_ROLES = {"fast", "deep"}


def _read_private_providers() -> dict:
    try:
        raw = json.loads(config.PRIVATE_PROVIDERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    return raw if isinstance(raw, dict) else {}


@app.get("/v1/routing")
async def get_routing():
    """读取直连路由（providers.json 合并结果）：M5/M15 的 provider+model_role 与各 provider 模型名。"""
    merged = config.load_provider_config()
    models = {name: (info.get("models") or {}) for name, info in merged.get("providers", {}).items()
              if isinstance(info, dict)}
    return {"routing": merged.get("routing", {}), "models": models,
            "providers": sorted(_ROUTING_PROVIDERS)}


@app.put("/v1/routing")
async def put_routing(payload: dict):
    """写入直连路由覆盖到私有 providers.json（调度器每任务热重载，无需重启）。

    入参：{"routing": {"M5": {"provider", "model_role"}, "M15": {...}},
          "models": {"zhipu": {"fast": "...", "deep": "..."}}}
    provider 白名单：ollama/deepseek/openai/qwen/zhipu；model_role：fast/deep。
    密钥不在此端点管理，也绝不写入日志。
    """
    routing_in = payload.get("routing")
    models_in = payload.get("models")
    if not isinstance(routing_in, dict) or not routing_in:
        raise HTTPException(status_code=422, detail={"error": "routing_required"})
    cleaned: dict = {}
    for tf, entry in routing_in.items():
        if tf not in _ROUTING_TFS or not isinstance(entry, dict):
            raise HTTPException(status_code=422, detail={"error": "routing_invalid", "field": str(tf)})
        provider = str(entry.get("provider", "")).strip().lower()
        role = str(entry.get("model_role", "fast")).strip().lower()
        if provider not in _ROUTING_PROVIDERS or role not in _ROUTING_ROLES:
            raise HTTPException(status_code=422, detail={
                "error": "routing_invalid", "field": str(tf),
                "detail": "provider 或 model_role 不在白名单",
            })
        cleaned[tf] = {"provider": provider, "model_role": role}
    models_clean: dict = {}
    if isinstance(models_in, dict):
        for provider, roles in models_in.items():
            if provider not in _ROUTING_PROVIDERS:
                raise HTTPException(status_code=422, detail={"error": "models_invalid", "field": str(provider)})
            if not isinstance(roles, dict):
                continue
            entry: dict = {}
            for role in ("fast", "deep"):
                name = str(roles.get(role, "")).strip()
                if name:
                    entry[role] = name[:80]
            if entry:
                models_clean[provider] = entry
    raw = _read_private_providers()
    raw["routing"] = {**(raw.get("routing") or {}), **cleaned}
    if models_clean:
        block = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
        for provider, entry in models_clean.items():
            current = block.get(provider) if isinstance(block.get(provider), dict) else {}
            current["models"] = {**(current.get("models") or {}), **entry}
            block[provider] = current
        raw["providers"] = block
    try:
        config.PRIVATE_PROVIDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.PRIVATE_PROVIDERS_FILE.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        log.error("路由写入失败: %s", e)
        raise HTTPException(status_code=500, detail={"error": "save_failed"})
    merged = config.load_provider_config()
    return {"status": "ok", "hot_reload": "调度器每任务自动热重载",
            "routing": merged.get("routing"),
            "models": {name: (info.get("models") or {}) for name, info in merged.get("providers", {}).items()
                       if isinstance(info, dict)}}


@app.put("/v1/providers/credential")
async def put_provider_credential(payload: dict):
    """保存用户选择的在线提供商并热切换 M5/M15；响应永不包含密钥。"""
    provider = str(payload.get("provider") or "").strip().lower()
    supported = {"zhipu", "deepseek", "openai", "qwen", "gemini", "minimax", "groq", "openrouter", "custom"}
    if provider not in supported:
        raise HTTPException(status_code=422, detail={"error": "provider_invalid"})
    api_key = str(payload.get("api_key") or "").strip()
    defaults = {"zhipu": "glm-4.5-air", "deepseek": "deepseek-chat", "openai": "gpt-4.1-mini", "qwen": "qwen-plus", "gemini": "gemini-2.5-flash", "minimax": "MiniMax-M2.7", "groq": "openai/gpt-oss-120b", "openrouter": "openai/gpt-4.1-mini", "custom": ""}
    bases = {"zhipu": "https://open.bigmodel.cn/api/paas/v4", "deepseek": "https://api.deepseek.com", "openai": "https://api.openai.com/v1", "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1", "gemini": "https://generativelanguage.googleapis.com/v1beta/openai", "minimax": "https://api.minimaxi.com/v1", "groq": "https://api.groq.com/openai/v1", "openrouter": "https://openrouter.ai/api/v1"}
    model = str(payload.get("model") or defaults[provider]).strip()[:120]
    base_url = str(payload.get("base_url") or bases.get(provider) or "").strip().rstrip("/")[:500]
    if provider == "custom" and not (base_url.startswith("https://") or base_url.startswith("http://127.0.0.1:") or base_url.startswith("http://localhost:")):
        raise HTTPException(status_code=422, detail={"error": "base_url_invalid"})
    if not model:
        raise HTTPException(status_code=422, detail={"error": "model_required"})
    if len(api_key) < 20:
        raise HTTPException(status_code=422, detail={"error": "credential_required"})
    raw = _read_private_providers()
    providers = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
    current = providers.get(provider) if isinstance(providers.get(provider), dict) else {}
    current.update({"enabled": True, "base_url": base_url, "api_key": api_key,
                    "models": {"fast": model, "deep": model}})
    providers[provider] = current
    raw["providers"] = providers
    raw["routing"] = {**(raw.get("routing") or {}),
                      "M5": {"provider": provider, "model_role": "fast"},
                      "M15": {"provider": provider, "model_role": "deep"}}
    try:
        config.PRIVATE_PROVIDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.PRIVATE_PROVIDERS_FILE.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        raise HTTPException(status_code=500, detail={"error": "save_failed"})
    return {"status": "ok", "provider": provider, "configured": True, "model": model,
            "routing": {"M5": provider, "M15": provider}}


@app.get("/v1/states/current")
async def get_state_current(
    symbol: str = Query(..., pattern="^[A-Z]{6}$"),
    timeframe: str = Query(..., pattern="^(M5|M15)$"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
):
    """任务 E：统一判断状态接口（M1 契约 enkei-ai-state/v1）。

    - M5/M15 共用同一契约；M1 周期不参与（返回 422）；
    - 支持 ETag 与 304（If-None-Match 命中时返回 304，不返回 body）；
    - degraded 反映当前判断可用性：none / fallback / stale / invalid；
    - policy 过期但仍有记录时返回 stale 状态（200），无任何记录返回 404。
    """
    if timeframe == "M1":
        raise HTTPException(status_code=422, detail={"error": "timeframe_not_supported",
                                                     "detail": "M1 周期不参与 AI 判断，请使用 M5/M15"})
    policy, etag = store.get_latest(symbol, timeframe)
    if policy is None:
        raise HTTPException(status_code=404, detail={
            "status": "no_state", "symbol": symbol, "timeframe": timeframe,
            "detail": "该 symbol/timeframe 尚无 AI 判断记录",
        })

    # 判断 degraded：有效期内沿用生成时状态；过期 → stale
    degraded = policy.get("degraded", "none")
    try:
        from datetime import datetime as _dt, timezone as _tz
        expires = _dt.fromisoformat(policy.get("expires_at", "").replace("Z", "+00:00"))
        expired = expires < _dt.now(_tz.utc)
    except Exception:
        expired = False
    if expired:
        degraded = "stale"

    state = validator.build_state(policy, degraded=degraded,
                                  request_id=policy.get("request_id", ""))
    headers = {"ETag": etag}
    if if_none_match and if_none_match.strip() == etag and not expired:
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=state, headers=headers)
