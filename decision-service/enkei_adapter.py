# -*- coding: utf-8 -*-
"""圆衡 Enkei - FX 行情适配器（EnkeiMarketAdapter）

P1 阶段核心：把 8788 行情桥（MT4 只读历史）映射为决策引擎所需的
标准 OHLCV 数据与中文技术摘要，并负责数据新鲜度熔断。

只读：不写入任何交易/券商接口。熔断时输出 unavailable 状态，
决策引擎在该状态下只能降级为 observe-only。

对外主要方法：
  - health() -> dict                      行情桥健康
  - fetch_history(symbol, timeframe, limit) -> (bars, meta)  原生 bars
  - build_snapshot(symbol, timeframe, limit) -> dict         结构化市场快照
  - build_instrument_context(snapshot) -> str                供 analyst 的中文摘要

provenance（溯源）统一挂在 snapshot["market_data"] 下：
  source / fetched_at / latest_bar_time / file_age_ms / clock / adjustment / total_bars
"""
from __future__ import annotations

import json
import logging
import math
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("enkei.adapter")

# 对齐行情桥 server.mjs 的支持集
SUPPORTED_SYMBOLS = ("USDJPY", "EURUSD", "EURJPY", "GBPUSD", "GBPJPY", "AUDJPY")
SUPPORTED_TIMEFRAMES = ("M1", "M5", "M15", "H1", "H4", "D1", "W1", "MN1", "Y1")
# 决策服务对外建议周期（行情桥全支持，但 TA 分析按 M5/M15 为主）
DECISION_TIMEFRAMES = ("M5", "M15", "H1")

# 新鲜度阈值（秒）
FRESH_MS = 15 * 60_000        # 快照 age_ms ≤ 15min 视为实时可用
STALE_MS = 6 * 3600 * 1000    # 超过 6h 视为过期（历史仍可读，但实时性熔断）


class AdapterUnavailableError(RuntimeError):
    """行情桥不可达 / 数据过期熔断。"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _http_get_json(url: str, timeout_s: float) -> Any:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 (仅 127.0.0.1)
        return json.loads(resp.read().decode("utf-8"))


class EnkeiMarketAdapter:
    def __init__(self, base_url: str = "http://127.0.0.1:8788", timeout_s: float = 5.0):
        self.base = base_url.rstrip("/")
        self.timeout_s = timeout_s

    # ---------- 基础交互 ----------
    def health(self) -> dict:
        try:
            data = _http_get_json(f"{self.base}/api/health", self.timeout_s)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            raise AdapterUnavailableError(f"行情桥不可达: {exc}") from exc
        return data

    def fetch_history(self, symbol: str, timeframe: str, limit: int = 120) -> tuple[list[dict], dict]:
        """拉取原生 bars，返回 (bars, meta)。

        meta 含 total_bars / latest_bar_time / file_age_ms / clock ，
        用于新鲜度判定与 provenance。
        """
        sym = self._normalise_symbol(symbol)
        tf = self._normalise_timeframe(timeframe)
        url = f"{self.base}/api/history?symbol={sym}&timeframe={tf}&limit={limit}"
        try:
            data = _http_get_json(url, self.timeout_s)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            raise AdapterUnavailableError(f"行情 {sym} {tf} 拉取失败: {exc}") from exc
        if "bars" not in data or not isinstance(data.get("bars"), list):
            raise AdapterUnavailableError(f"行情 {sym} {tf} 返回结构异常: {data.get('error')}")
        bars = data["bars"]
        if not bars:
            raise AdapterUnavailableError(f"行情 {sym} {tf} 无可用 K 线（历史未就绪）")
        meta = {
            "source": "mt4-bridge:8788",
            "symbol": data.get("symbol", sym),
            "timeframe": tf,
            "total_bars": data.get("total_bars"),
            "latest_bar_time": data.get("latest_bar_time"),
            "file_age_ms": data.get("file_age_ms"),
            "clock": data.get("clock", {}),
        }
        return bars, meta

    def fetch_snapshot_quote(self, symbol: str) -> dict | None:
        """实时报价（bid/ask）。快照过期时返回 None，不抛错。"""
        try:
            snap = _http_get_json(f"{self.base}/api/snapshot", self.timeout_s)
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return None
        if not isinstance(snap, dict):
            return None
        age = snap.get("age_ms")
        if not isinstance(age, (int, float)) or not math.isfinite(age) or not 0 <= age <= 10_000:
            return None
        if snap.get("clock_status") not in ("aligned", "offset-corrected"):
            return None
        rows = snap.get("quotes") if isinstance(snap.get("quotes"), list) else [snap]
        for row in rows:
            if not isinstance(row, dict) or self._normalise_symbol(row.get("symbol")) != self._normalise_symbol(symbol):
                continue
            bid, ask = row.get("bid"), row.get("ask")
            if all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in (bid, ask)) and ask >= bid:
                return {**row, "age_ms": age, "clock_status": snap["clock_status"]}
        return None

    # ---------- 数据映射 ----------
    @staticmethod
    def _normalise_symbol(value: str) -> str:
        return "".join(ch for ch in str(value or "") if ch.isalpha()).upper()

    @staticmethod
    def _normalise_timeframe(value: str) -> str:
        return str(value or "").upper()

    @staticmethod
    def _bar_volume_bucket(bars: list[dict]) -> int:
        """估算成交量桶（桥历史无成交量字段，按 bar 数估算）。"""
        return len(bars)

    # ---------- 周期聚合 ----------
    _TF_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "H1": 60, "H4": 240, "D1": 1440}

    def aggregate(self, bars: list[dict], from_tf: str, to_tf: str) -> list[dict]:
        """把 from_tf 的 bars 聚合到 to_tf（仅限整数倍关系）。"""
        f = self._TF_MINUTES.get(from_tf.upper())
        t = self._TF_MINUTES.get(to_tf.upper())
        if f is None or t is None or t < f or (t % f) != 0:
            raise ValueError(f"不支持聚合 {from_tf} -> {to_tf}")
        bucket_minutes = t // f
        ordered = sorted(bars, key=lambda b: int(b["time"]))
        out: list[dict] = []
        current: dict | None = None
        for b in ordered:
            epoch = int(b["time"])
            bucket_start = epoch - (epoch % (t * 60))
            if current is None or current["time"] != bucket_start:
                current = {
                    "time": bucket_start,
                    "open": float(b["open"]),
                    "high": float(b["high"]),
                    "low": float(b["low"]),
                    "close": float(b["close"]),
                    "count": 1,
                }
                out.append(current)
            else:
                current["high"] = max(current["high"], float(b["high"]))
                current["low"] = min(current["low"], float(b["low"]))
                current["close"] = float(b["close"])
                current["count"] += 1
        for c in out:
            c.pop("count", None)
        return out

    # ---------- 技术特征 ----------
    @staticmethod
    def _ema(values: list[float], span: int) -> float | None:
        if len(values) < span:
            return None
        k = 2 / (span + 1)
        ema = values[0]
        for v in values[1:]:
            ema = v * k + ema * (1 - k)
        return ema

    def _compute_features(self, bars: list[dict]) -> dict:
        closes = [float(b["close"]) for b in bars]
        highs = [float(b["high"]) for b in bars]
        lows = [float(b["low"]) for b in bars]
        if not closes:
            return {}
        last = closes[-1]
        ema_fast = self._ema(closes, 12)
        ema_slow = self._ema(closes, 26)
        momentum = round((last - closes[0]) / closes[0] * 100.0, 4) if closes[0] else 0.0
        recent_high = max(highs[-min(len(highs), 60):])
        recent_low = min(lows[-min(len(lows), 60):])
        # 日均真实波幅近似（pip 计，JPY 对用 0.01 一个点）
        atr_pips = None
        if len(bars) >= 2:
            total = 0.0
            pairs = list(zip(bars, bars[1:]))[-14:]
            for a, b in pairs:
                total += max(
                    float(b["high"]) - float(b["low"]),
                    abs(float(b["high"]) - float(a["close"])),
                    abs(float(b["low"]) - float(a["close"])),
                )
            atr_raw = total / len(pairs)
            pip = (0.01 if "JPY" in (bars[0].get("_symbol") or "") else 0.0001)
            atr_pips = round(atr_raw / pip, 1)
        return {
            "last_price": round(last, 5),
            "ema_fast": round(ema_fast, 5) if ema_fast else None,
            "ema_slow": round(ema_slow, 5) if ema_slow else None,
            "momentum_pct": momentum,
            "recent_high": round(recent_high, 5),
            "recent_low": round(recent_low, 5),
            "range_pips": round((recent_high - recent_low) / (0.01 if "JPY" in (bars[0].get("_symbol") or "") else 0.0001), 1),
            "atr_pips": atr_pips,
        }

    # ---------- 熔断（新鲜度） ----------
    def _freshness(self, meta: dict) -> dict:
        """返回 fresh 状态：ready / stale / unavailable（含原因）。"""
        age_ms = meta.get("file_age_ms")
        clock = meta.get("clock", {})
        reasons = []
        if age_ms is None:
            reasons.append("missing file_age_ms")
        elif not isinstance(age_ms, (int, float)) or not math.isfinite(age_ms) or age_ms < 0:
            reasons.append("invalid file_age_ms")
        elif age_ms > FRESH_MS:
            reasons.append(f"file_age_ms={int(age_ms/1000)}s 超过过期阈值")
        if clock.get("status") == "unresolved":
            reasons.append("clock=unresolved（MT4 未对齐，时间戳可能含偏移）")
        elif clock.get("status") == "unavailable":
            reasons.append("clock=unavailable（无快照）")
        elif clock.get("status") not in ("aligned", "offset-corrected"):
            reasons.append("clock status missing or unknown")
        level = "stale" if reasons else "ready"
        # 桥本身不可达时由调用方抛 AdapterUnavailableError -> unavailable
        return {"level": level, "reasons": reasons}

    # ---------- 对外快照 ----------
    def build_snapshot(self, symbol: str, timeframe: str = "M15", limit: int = 120) -> dict:
        """构造标准市场快照（P1 决策输入）。数据不足以分析时抛 AdapterUnavailableError。"""
        tf = self._normalise_timeframe(timeframe)
        bars, meta = self.fetch_history(symbol, tf, limit)
        for b in bars:
            b["_symbol"] = meta["symbol"]
        freshness = self._freshness(meta)
        features = self._compute_features(bars)
        quote = self.fetch_snapshot_quote(symbol)
        if quote is None:
            freshness = {"level": "stale", "reasons": [*freshness["reasons"], "matching fresh quote unavailable"]}
        return {
            "version": "enkei-market-snapshot/v1",
            "generated_at": _now_iso(),
            "symbol": meta["symbol"],
            "timeframe": tf,
            "bars": bars[-limit:],
            "bar_count": len(bars),
            "features": features,
            "quote": quote,
            "market_data": {
                "source": meta["source"],
                "total_bars": meta["total_bars"],
                "latest_bar_time": meta["latest_bar_time"],
                "file_age_ms": meta["file_age_ms"],
                "clock": meta["clock"],
                "freshness": freshness,
            },
        }

    # ---------- 供 analyst 的中文技术摘要 ----------
    def build_instrument_context(self, snapshot: dict) -> str:
        """把快照渲染为 analyst prompt 用的中文上下文（替代 yfinance 的 instrument_context）。"""
        sym = snapshot["symbol"]
        tf = snapshot["timeframe"]
        f = snapshot.get("features", {})
        md = snapshot.get("market_data", {})
        freshness = md.get("freshness", {}).get("level", "unknown")
        lines = [
            f"标的：{sym}（外汇 CFD，只读行情，非股票）",
            f"周期：{tf}；数据源：{md.get('source')}；数据条数：{snapshot.get('bar_count')}",
            f"新鲜度：{freshness}", 
        ]
        quote = snapshot.get("quote")
        if isinstance(quote, dict):
            lines.append(f"本品种报价：Bid={quote.get('bid')} Ask={quote.get('ask')}；快照年龄={quote.get('age_ms')}ms")
        if f.get("last_price") is not None:
            lines.append(
                f"最新收盘价 {f['last_price']}；EMA12={f.get('ema_fast')}；EMA26={f.get('ema_slow')}；"
                f"近60根高点 {f.get('recent_high')} / 低点 {f.get('recent_low')}；"
                f"区间 {f.get('range_pips')} pips；ATR≈{f.get('atr_pips')} pips；"
                f"周期动量 {f.get('momentum_pct')}%"
            )
        trend = "未定"
        if f.get("ema_fast") is not None and f.get("ema_slow") is not None:
            if f["ema_fast"] > f["ema_slow"]:
                trend = "偏多（EMA12>EMA26）"
            elif f["ema_fast"] < f["ema_slow"]:
                trend = "偏空（EMA12<EMA26）"
        lines.append(f"技术态势：{trend}")
        if freshness != "ready":
            lines.append("注意：数据非实时，请保守评估，仅可作研究参考。")
        # 附最近 5 根 K 线
        lines.append("最近5根K线(time,open,high,low,close):")
        for b in snapshot["bars"][-5:]:
            lines.append(f"  {b['time']}: {b['open']} {b['high']} {b['low']} {b['close']}")
        return "\n".join(lines)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    a = EnkeiMarketAdapter()
    try:
        snap = a.build_snapshot("USDJPY", "M15", 120)
        print(json.dumps(snap, ensure_ascii=False, indent=2)[:3000])
        print("\n--- instrument_context ---")
        print(a.build_instrument_context(snap))
    except AdapterUnavailableError as exc:
        print(f"ADAPTER_UNAVAILABLE: {exc}")
