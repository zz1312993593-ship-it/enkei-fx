"""圆衡回测信号策略 —— 对接 Vibe-Trading 回测引擎的信号契约。

契约：``SignalEngine.generate(data_map) -> Dict[code, pd.Series]``
- data_map: code -> OHLCV DataFrame（DatetimeIndex UTC-naive + open/high/low/close/volume）
- 返回的 Series 与 data_map 同索引，值为目标权重 ∈ [-1, 1]：
  +1 全仓做多 / -1 全仓做空 / 0 空仓 / 中间值为部分仓位
- 引擎侧会对信号做 shift(1)（次日开盘成交）并归一化 sum(abs(w))<=1

本模块只表达"信号假设"，不含任何执行/风控逻辑；执行层护城河（8791 网关 + EA）
保持零改动，回测结果仅用于研究与复盘。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict

import pandas as pd


class BaseStrategy(ABC):
    """回测策略基类。子类实现 generate()。"""

    name: str = "base"
    # 目标权重统一缩放（仓位比例）：1.0=满杠杆，默认 0.3 为保守研究仓位：
    # 让保证金长期远低于可用资金，避免浮盈/亏损引发的自动加减仓
    # 撞上 "insufficient capital" 上限（50:1 杠杆 + 全仓时必然爆仓）。
    scale: float = 0.3

    @abstractmethod
    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        ...

    def _apply_scale(self, sig: pd.Series) -> pd.Series:
        return sig * self.scale

    def __repr__(self) -> str:  # 用于报告标注
        return self.name


class EMACross(BaseStrategy):
    """指数均线交叉趋势跟随：快线上穿慢线做多(+1)，下穿做空(-1)。

    Args:
        fast: 快线周期，默认 20。
        slow: 慢线周期，默认 60。
    """

    name = "ema-cross"

    def __init__(self, fast: int = 20, slow: int = 60, scale: float = 0.3) -> None:
        if fast <= 0 or slow <= 0 or fast >= slow:
            raise ValueError("需满足 0 < fast < slow")
        self.fast = fast
        self.slow = slow
        self.scale = scale
        self.name = f"ema-cross({fast}/{slow})"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        out: Dict[str, pd.Series] = {}
        for code, df in data_map.items():
            close = df["close"]
            fast = close.ewm(span=self.fast, adjust=False).mean()
            slow = close.ewm(span=self.slow, adjust=False).mean()
            # diff>0 上穿 → +1；diff<0 下穿 → -1；NaN 预热期 0
            diff = fast - slow
            sig = (diff > 0).astype(float) - (diff < 0).astype(float)
            sig[diff.isna()] = 0.0
            out[code] = self._apply_scale(sig.rename("signal").astype(float))
        return out


class ChannelBreakout(BaseStrategy):
    """唐奇安通道突破：创 N 根最高价高点做多(+1)，创 N 根最低价低点做空(-1)。

    Args:
        window: 通道周期，默认 20。
    """

    name = "channel-breakout"

    def __init__(self, window: int = 20, scale: float = 0.3) -> None:
        if window <= 1:
            raise ValueError("window 需 > 1")
        self.window = window
        self.scale = scale
        self.name = f"channel-breakout({window})"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        out: Dict[str, pd.Series] = {}
        for code, df in data_map.items():
            high = df["high"]
            low = df["low"]
            w = self.window
            upper = high.rolling(w).max().shift(1)   # 不含当前 K 的突破
            lower = low.rolling(w).min().shift(1)
            sig = pd.Series(0.0, index=df.index)
            sig[df["close"] > upper] = 1.0
            sig[df["close"] < lower] = -1.0
            # 通道未就绪期置 0
            sig[upper.isna()] = 0.0
            out[code] = self._apply_scale(sig.rename("signal").astype(float))
        return out


class Momentum(BaseStrategy):
    """N 根收益率动量：涨幅为正全仓多(+1)，为负全仓空(-1)。

    Args:
        lookback: 动量回看周期，默认 24（约 1 个交易日 @1H）。
    """

    name = "momentum"

    def __init__(self, lookback: int = 24, scale: float = 0.3) -> None:
        if lookback <= 0:
            raise ValueError("lookback 需 > 0")
        self.lookback = lookback
        self.scale = scale
        self.name = f"momentum({lookback})"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        out: Dict[str, pd.Series] = {}
        for code, df in data_map.items():
            ret = df["close"].pct_change(self.lookback)
            sig = pd.Series(0.0, index=df.index)
            sig[ret > 0] = 1.0
            sig[ret < 0] = -1.0
            sig[ret.isna()] = 0.0
            out[code] = self._apply_scale(sig.rename("signal").astype(float))
        return out


# 策略注册表：名称 -> 工厂，方便 CLI 按名选择
STRATEGIES: Dict[str, Any] = {
    "ema-cross": EMACross,
    "channel-breakout": ChannelBreakout,
    "momentum": Momentum,
}


def build_strategy(name: str, **kwargs) -> BaseStrategy:
    """按名称构建策略实例；未知名称报错并列出可用项。"""
    if name not in STRATEGIES:
        available = ", ".join(sorted(STRATEGIES))
        raise ValueError(f"未知策略 {name!r}，可用: {available}")
    return STRATEGIES[name](**kwargs)
