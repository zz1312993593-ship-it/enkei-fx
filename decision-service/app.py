# -*- coding: utf-8 -*-
"""圆衡 Enkei 决策服务 - FastAPI（仅 127.0.0.1）

接口：
  POST /v1/signal     入参 {symbol, timeframe, limit?, note?} -> 202 {request_id}
  GET  /v1/decision   出参 ?request_id= -> 200 决策 / 404 未知 / 409 进行中
  GET  /v1/health     服务健康 + 行情桥状态
  GET  /v1/coverage   支持标的/周期

设计：
  - 单 worker、最多 1 个并发深度分析（本地算力约束）
  - 决策结果同时落内存与磁盘（data/decisions/*.json，审计）
  - 绑定 127.0.0.1，无 CORS 开放
"""
from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import load_gateway, load_service
from decision_schema import DECISION_SCHEMA, validate_signal_input, validate_decision
from enkei_adapter import EnkeiMarketAdapter, AdapterUnavailableError, SUPPORTED_SYMBOLS, DECISION_TIMEFRAMES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logger = logging.getLogger("enkei.decision-service")

app = FastAPI(title="Enkei Decision Service", version="0.1.0", docs_url=None, redoc_url=None)
CFG = load_service()
GATEWAY = load_gateway()

# 全局运行态（仅本进程）
_request_index: dict[str, dict] = {}      # request_id -> 状态记录
_running_sem = threading.Semaphore(CFG.max_concurrent)
_lock = threading.Lock()


class SignalRequest(BaseModel):
    symbol: str = Field(..., description="外汇对，如 USDJPY")
    timeframe: str = Field("M15", description="M5 / M15 / H1")
    limit: int = Field(120, ge=20, le=500)
    note: str = Field("", max_length=500)


@app.get("/v1/health")
def health():
    adapter = EnkeiMarketAdapter()
    try:
        bridge = adapter.health()
        bridge_status = bridge.get("status", "unknown")
    except AdapterUnavailableError as exc:
        bridge_status = "unavailable"
    return {
        "service": "enkei-decision-service",
        "status": "ok",
        "bridge": bridge_status,
        "running_tasks": sum(1 for r in list(_request_index.values()) if r.get("status") in ("queued", "pending")),
    }


@app.get("/v1/coverage")
def coverage():
    return {"symbols": list(SUPPORTED_SYMBOLS), "timeframes": list(DECISION_TIMEFRAMES), "concurrency": CFG.max_concurrent}


@app.post("/v1/signal")
def submit_signal(body: SignalRequest):
    payload = body.model_dump(exclude_none=True)
    errs = validate_signal_input(payload)
    if errs:
        raise HTTPException(status_code=422, detail={"errors": errs})
    request_id = f"{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    with _lock:
        if any(r.get("status") in ("queued", "pending") for r in _request_index.values()):
            raise HTTPException(status_code=409, detail="已有深度分析正在运行，请等待完成，避免重复消耗模型额度。")
        _request_index[request_id] = {"status": "queued", "submitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    def _worker():
        with _running_sem:
            with _lock:
                _request_index[request_id]["status"] = "pending"
            try:
                from ta_runner import run_analysis
                decision = run_analysis(
                    request_id=request_id,
                    symbol=payload["symbol"],
                    timeframe=payload["timeframe"],
                    gateway=GATEWAY,
                    store_dir=CFG.decision_store_dir,
                    limit=payload.get("limit", 120),
                    note=payload.get("note", ""),
                )
                with _lock:
                    _request_index[request_id] = {
                        "status": decision.get("status"),
                        "signal": decision.get("signal"),
                        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    }
            except Exception as exc:  # noqa: BLE001
                logger.exception("[%s] worker crashed", request_id)
                with _lock:
                    _request_index[request_id] = {"status": "failed", "error": str(exc)}

    threading.Thread(target=_worker, daemon=True, name=f"enkei-{request_id}").start()
    return JSONResponse(status_code=202, content={"request_id": request_id, "status": "queued" })


@app.get("/v1/decision")
def get_decision(request_id: str = Query(..., pattern=r"^[A-Za-z0-9_-]{1,80}$")):
    path: Path = CFG.decision_store_dir / f"{request_id}.json"
    if path.exists():
        try:
            decision = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            raise HTTPException(status_code=500, detail="决策文件损坏")
        errs = validate_decision(decision)
        if errs:
            raise HTTPException(status_code=500, detail={"errors": errs, "decision": decision})
        return decision
    with _lock:
        rec = _request_index.get(request_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="request_id 不存在")
    if rec.get("status") in ("queued", "pending"):
        raise HTTPException(status_code=409, detail="仍在分析中，请稍后重试")
    raise HTTPException(status_code=500, detail=f"分析失败: {rec}")


@app.get("/v1/schema")
def schema():
    return DECISION_SCHEMA


@app.get("/v1/context")
def research_context(symbol: str = Query(..., pattern="^[A-Z]{6}$"), timeframe: str = Query(..., pattern="^(M5|M15|H1)$")):
    from context_export import latest_context
    return latest_context(CFG.decision_store_dir, symbol, timeframe)
