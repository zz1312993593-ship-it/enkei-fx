# -*- coding: utf-8 -*-
"""圆衡 Enkei 决策引擎 - TradingAgents 封装（ta_runner）

把 TradingAgents 多角色流水线封装为可调用一次的函数：
  1. EnkeiAdapter 构造真实 FX 市场快照
  2. 子类化 TradingAgentsGraph 覆写 resolve_instrument_context，
     把行情桥数据注入分析师上下文（绕开 yfinance）
  3. propagate(symbol, trade_date) 跑完全流程，返回 (final_state, signal)
  4. 标准化为 enkei-decision/v1 决策对象（含 provenance / evidence / TTL）

资产类型走 asset_type，明确非股票路径，仅作研究输出，不接触任何执行接口。
"""
from __future__ import annotations

import json
import logging
import os
import time
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from enkei_adapter import EnkeiMarketAdapter, AdapterUnavailableError
from decision_schema import DECISION_TTL_BY_TIMEFRAME, validate_decision

logger = logging.getLogger("enkei.ta_runner")

_FRAMEWORK = {"name": "TradingAgents", "version": "0.4.0"}
# 5 档评级 → 方向
_SIGNAL_TO_BIAS = {
    "Strong Buy": "long",
    "Buy": "long",
    "Hold": "wait",
    "Sell": "short",
    "Strong Sell": "short",
    "Overweight": "long",
    "Underweight": "short",
}


class EnkeiTradingGraph:
    """延迟导入的子类包装，避免顶层 import 拖慢服务启动（懒加载）。"""

    @classmethod
    def build(cls, snapshot: dict, gateway: Any):
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from tradingagents.default_config import DEFAULT_CONFIG

        agent_id = gateway.unified_agent_id
        base = gateway.librechat_base_url.rstrip("/")
        backend_url = f"{base}/api/agents/v1"
        os.environ["OPENAI_COMPATIBLE_API_KEY"] = gateway.librechat_api_key

        config = DEFAULT_CONFIG.copy()
        config.update({
            "llm_provider": "openai_compatible",
            "deep_think_llm": agent_id,
            "quick_think_llm": agent_id,
            "backend_url": backend_url,
            "max_debate_rounds": 1,
            "max_risk_discuss_rounds": 1,
            "output_language": "Chinese",
        })

        class _Graph(TradingAgentsGraph):
            _enkei_snapshot = snapshot

            def _create_tool_nodes(self):
                from fx_tools import create_fx_tool_nodes
                return create_fx_tool_nodes(self._enkei_snapshot)

            def resolve_instrument_context(self, ticker: str, asset_type: str = "stock") -> str:
                # 直接使用行情桥注入的 FX 摘要，替代 yfinance 的确定性查找
                adapter = EnkeiMarketAdapter()
                try:
                    return adapter.build_instrument_context(self._enkei_snapshot)
                except Exception:  # noqa: BLE001 - 兜底返回可读文本
                    raise AdapterUnavailableError(f"标的 {ticker}：行情上下文注入失败")

        return _Graph(
            selected_analysts=("market", "news"),
            config=config,
            debug=True,
        )


def _latest_bar_utc_date(snapshot: dict) -> str:
    ts = snapshot.get("market_data", {}).get("latest_bar_time")
    if ts:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _infer_regime(snapshot: dict, bias: str) -> str:
    """regime 推断：拆分子时点/区间大波动 → volatile，否则 trend/range。"""
    f = snapshot.get("features", {})
    rng = f.get("range_pips")
    atr = f.get("atr_pips")
    if rng and rng >= 250:
        return "volatile"
    ema_fast, ema_slow = f.get("ema_fast"), f.get("ema_slow")
    if ema_fast is not None and ema_slow is not None:
        gap = abs(ema_fast - ema_slow) / ema_slow if ema_slow else 0
        if gap > 0.0015:
            return "trend"
        return "range"
    return "uncertain"


def _summarise_evidence(state: dict, snapshot: dict) -> list[dict]:
    items = []
    for role, key in (
        ("market", "market_report"),
        ("news", "news_report"),
        ("sentiment", "sentiment_report"),
        ("fundamentals", "fundamentals_report"),
    ):
        text = state.get(key, "") or ""
        if text.strip():
            items.append({"role": role, "summary": text[:600]})
    return items[:8]


def run_analysis(
    request_id: str,
    symbol: str,
    timeframe: str,
    gateway: Any,
    store_dir: Path,
    limit: int = 120,
    note: str = "",
) -> dict:
    """执行一次深度决策分析，返回标准化 enkei-decision/v1 决策对象并落盘。

    freshness != ready 时直接熔断为 observe-only，不调用模型。
    """
    t0 = time.time()
    adapter = EnkeiMarketAdapter()
    decision: dict[str, Any] = {
        "version": "enkei-decision/v1",
        "request_id": request_id,
        "status": "pending",
        "symbol": symbol,
        "timeframe": timeframe,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "expires_at": "",
        "framework": _FRAMEWORK,
        "provider": {"kind": "librechat-unified-agent", "model_or_agent": gateway.unified_agent_id},
        "signal": "None",
        "action_bias": "observe",
        "confidence": 0,
        "regime": "uncertain",
        "market_data": {},
        "evidence": [],
        "analyst_reports": {},
        "note": note,
    }

    try:
        # 1. 行情快照（熔断在此发生：桥不可达/无数据 → observe-only）
        snapshot = adapter.build_snapshot(symbol, timeframe, limit)
        md = snapshot.get("market_data", {})
        decision["market_data"] = {
            "source": md.get("source"),
            "fetched_at": snapshot.get("generated_at"),
            "latest_bar_time": md.get("latest_bar_time"),
            "file_age_ms": md.get("file_age_ms"),
            "total_bars": md.get("total_bars"),
            "clock": md.get("clock"),
            "freshness": md.get("freshness", {"level": "unknown", "reasons": []}),
        }
        freshness_level = md.get("freshness", {}).get("level", "unknown")
        if freshness_level != "ready":
            # 过期、断流或时钟未对齐时，绝不能再花费一次完整 Agent
            # 调用去生成看似详细、却没有可操作性的报告。
            decision["status"] = "observe-only"
            decision["rationale_zh"] = "行情数据未通过新鲜度校验，已跳过深度模型分析，仅保留观察状态。"
            decision["evidence"] = [{
                "role": "data_freshness",
                "summary": "; ".join(md.get("freshness", {}).get("reasons", [])) or f"freshness={freshness_level}",
            }]
            logger.warning("[%s] skip model analysis: freshness=%s", request_id, freshness_level)
        else:
            # 2. 仅对已通过行情质量校验的数据运行 TradingAgents 全流程。
            trade_date = _latest_bar_utc_date(snapshot)
            from fx_tools import read_news
            snapshot["news_evidence"] = read_news(symbol)
            logger.info("[%s] start propagate %s %s (%s)", request_id, symbol, trade_date, timeframe)
            graph = EnkeiTradingGraph.build(snapshot, gateway)
            state, signal = graph.propagate(symbol, trade_date, asset_type="crypto")

            # 3. 标准化
            decision["signal"] = str(signal)
            bias = _SIGNAL_TO_BIAS.get(str(signal), "wait")
            decision["action_bias"] = bias
            decision["regime"] = _infer_regime(snapshot, bias)
            full_text = (state.get("final_trade_decision") or "").strip()
            decision["decision_text"] = full_text
            decision["rationale_zh"] = full_text[:2000]
            decision["evidence"] = _summarise_evidence(state, snapshot)
            decision["analyst_reports"] = {
                "market_len": len(state.get("market_report", "") or ""),
                "news_len": len(state.get("news_report", "") or ""),
                "sentiment_len": len(state.get("sentiment_report", "") or ""),
                "fundamentals_len": len(state.get("fundamentals_report", "") or ""),
            }
            # 置信度：从文本中尽力提取，无则给中性默认
            decision["confidence"] = _extract_confidence(full_text, bias)
            decision["status"] = "ready"
            if str(signal) not in _SIGNAL_TO_BIAS or not full_text or not state.get("market_report"):
                decision.update(status="observe-only", signal="None", action_bias="observe", confidence=0,
                                rationale_zh="框架未形成完整、可识别的市场判断，仅保留研究审计。")
    except AdapterUnavailableError as exc:
        decision["status"] = "observe-only"
        decision["error"] = f"行情不可用：{exc}"
        decision["rationale_zh"] = "数据层熔断，无法形成有效判断，建议维持观察。"
        # 即使桥完全不可达，也必须返回完整、可校验的 market_data，供调用方
        # 可靠展示降级原因，而不是把一个安全失败转换成 500。
        decision["market_data"] = {
            "source": "mt4-bridge:8788",
            "fetched_at": decision["generated_at"],
            "latest_bar_time": None,
            "file_age_ms": None,
            "total_bars": None,
            "clock": {},
            "freshness": {
                "level": "unavailable",
                "reasons": [str(exc)],
            },
        }
        decision["evidence"] = [{"role": "data_freshness", "summary": str(exc)}]
    except Exception as exc:  # noqa: BLE001
        logger.exception("[%s] analysis failed", request_id)
        decision["status"] = "failed"
        decision["error"] = f"{type(exc).__name__}: {exc}"
        # 模型侧限流/配额（429 / 503 / rate limit）是服务端暂时饱和，并非策略
        # 或数据错误：若已有通过新鲜度校验的行情，保守降级为 observe-only，
        # 保留下一次重试机会，而不是把可用数据一并标记为 failed。
        _msg = f"{type(exc).__name__}: {exc}".lower()
        if any(tok in _msg for tok in ("429", "rate limit", "too many requests", "quota", "503")) \
                and decision.get("market_data", {}).get("freshness", {}).get("level") == "ready":
            decision["status"] = "observe-only"
            decision["rationale_zh"] = "模型服务暂限流（HTTP 429/503），已保留有效行情数据并保守待观察，稍后可重试。"

    # 有效期
    ttl = DECISION_TTL_BY_TIMEFRAME.get(timeframe, 25 * 60)
    now = datetime.now(timezone.utc)
    decision["generated_at"] = now.isoformat(timespec="seconds")
    fetched_at = decision.get("market_data", {}).get("fetched_at")
    anchor = datetime.fromisoformat(fetched_at.replace("Z", "+00:00")) if fetched_at else now
    expires = anchor + timedelta(seconds=ttl)
    decision["expires_at"] = expires.isoformat(timespec="seconds")
    if decision["status"] == "ready" and expires <= now:
        decision.update(status="observe-only", action_bias="observe", signal="None", confidence=0,
                        rationale_zh="分析完成时行情快照已超出本周期有效期，需要新数据重新评估。")
    decision["volume"] = {"estimate_bars": _estimate_volume(decision)}

    errs = validate_decision(decision)
    if errs:
        decision.update(status="failed", action_bias="observe", signal="None", confidence=0)
        logger.warning("[%s] decision schema errors: %s", request_id, errs)
        decision["error"] = decision.get("error", "") + " | schema_errors=" + ";".join(errs[:3])
    decision["elapsed_s"] = round(time.time() - t0, 1)

    # 落盘（审计）
    store_dir.mkdir(parents=True, exist_ok=True)
    (store_dir / f"{request_id}.json").write_text(
        json.dumps(decision, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info("[%s] done in %.1fs status=%s signal=%s", request_id, decision["elapsed_s"], decision["status"], decision["signal"])
    return decision


def _extract_confidence(text: str, bias: str) -> int:
    """从决策文本提取置信度（0-100）。匹配 'confidence' / '置信度' 数字。"""
    import re
    patterns = [
        r"confidence['\":\s]*(\d{1,3})",
        r"置信度['\":\s]*(\d{1,3})",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            v = int(m.group(1))
            if 0 <= v <= 100:
                return v
    # 未提供的置信度不能伪造为 60/40。
    return 0


def _estimate_volume(decision: dict) -> int:
    n = decision.get("analyst_reports")
    if not n:
        return 0
    return sum(v for v in n.values() if isinstance(v, int))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    from config import load_gateway

    gw = load_gateway()
    out = run_analysis("manual-cli-test", "USDJPY", "M15", gw, Path(__file__).resolve().parent / "data" / "decisions")
    print(json.dumps({k: out[k] for k in ("request_id", "status", "signal", "action_bias", "regime", "confidence", "elapsed_s", "error") if k in out}, ensure_ascii=False, indent=2))
