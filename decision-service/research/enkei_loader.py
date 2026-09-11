"""圆衡数据仓馈送器 —— 把本地历史数据仓 CSV 转换成 Vibe-Trading 回测引擎可用的 OHLCV 面板。

契约对接 ``backtest.engines.base.BaseEngine.run_backtest(loader=...)``：
- loader 需提供 ``fetch(codes, start_date, end_date, *, interval, fields) -> Dict[code, pd.DataFrame]``
- 返回的 DataFrame：DatetimeIndex（UTC-naive）+ open/high/low/close/volume 列

数据仓格式（见 decision-service/enkei_warehouse.py）：
    data/warehouse/{SYMBOL}/{TIMEFRAME}.csv
    列: time,open,high,low,close   —— time 为 Unix 秒时间戳（UTC）
    无 volume 列，补 0。

非 Vibe-Trading 自带 local loader（那个要求 ~/.vibe-trading 配置目录，且其时间列
按 ISO 解析，无法直接吃 Unix 秒戳）；本馈送器直接读数据仓，保持离线只读。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# 数据仓根目录：decision-service/data/warehouse/{SYMBOL}/{TIMEFRAME}.csv
_WAREHOUSE_ROOT = Path(__file__).resolve().parent.parent / "data" / "warehouse"
# time 列的 Unix 秒 → Timestamp 单位
_TIME_UNIT = "s"


def _parse_code(code: str) -> tuple[str, str]:
    """code 形如 'USDJPY:H1' / 'EURUSD:M15'，返回 (symbol, timeframe)。

    带 TF 后缀，因为数据仓按 {SYMBOL}/{TIMEFRAME}.csv 组织，同一品种多周期独立成文件。
    """
    if ":" in code:
        symbol, tf = code.split(":", 1)
        return symbol.strip().upper(), tf.strip()
    raise ValueError(f"code 必须带周期冒号后缀，如 'USDJPY:H1'，实际是 {code!r}")


def _load_ohlcv(symbol: str, timeframe: str) -> pd.DataFrame:
    """读取单个品种单个周期的 CSV，返回标准化 OHLCV（DatetimeIndex UTC-naive）。"""
    path = _WAREHOUSE_ROOT / symbol / f"{timeframe}.csv"
    if not path.exists():
        raise FileNotFoundError(f"数据仓文件不存在: {path}")
    df = pd.read_csv(path)
    # time 列：Unix 秒 → UTC DatetimeIndex
    ts = pd.to_datetime(df["time"], unit=_TIME_UNIT, utc=True)
    # 用 .to_numpy() 避免 dict-of-Series 与自定义 DatetimeIndex 发生索引对齐
    # （Series 原索引是 RangeIndex，对齐后全变 NaN）
    df = pd.DataFrame(
        {
            "open": pd.to_numeric(df["open"]).to_numpy(),
            "high": pd.to_numeric(df["high"]).to_numpy(),
            "low": pd.to_numeric(df["low"]).to_numpy(),
            "close": pd.to_numeric(df["close"]).to_numpy(),
        },
        index=ts.dt.tz_convert(None).dt.as_unit("ns"),
    )
    # 转 UTC-naive（引擎契约），去空、去重复、排序
    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df["volume"] = 0.0
    return df


class EnkeiLocalLoader:
    """圆衡数据仓馈送器：fetch() 契约与 backtest 引擎保持一致。"""

    name = "enkei-local"

    def fetch(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1H",
        fields: Optional[List[str]] = None,
    ) -> Dict[str, pd.DataFrame]:
        """读取数据仓，按日期窗口裁剪。

        Args:
            codes: 形如 'USDJPY:H1' 的代码列表。
            start_date / end_date: YYYY-MM-DD（含端点）。
            interval: 与 code 内 TF 一致，用于校验保持一致。
            fields: 忽略。

        Returns:
            code -> OHLCV DataFrame。
        """
        result: Dict[str, pd.DataFrame] = {}
        start = pd.Timestamp(start_date)
        end = pd.Timestamp(end_date) + pd.Timedelta(days=1) - pd.Timedelta(seconds=1)

        for code in codes:
            try:
                symbol, tf = _parse_code(code)
                if interval and interval != tf:
                    logger.warning("code %s 指定 %s 但请求 interval=%s，以 code 内 TF 为准",
                                   code, tf, interval)
                df = _load_ohlcv(symbol, tf)
                df = df[(df.index >= start) & (df.index <= end)]
                if df.empty:
                    logger.warning("数据仓 %s 在 [%s, %s] 无数据", code, start_date, end_date)
                    continue
                result[code] = df.sort_index()
            except Exception as exc:  # 单品种失败不拖垮整个面板
                logger.warning("加载 %s 失败: %s", code, exc)

        if not result:
            logger.error("未从数据仓加载到任何数据（warehouse root=%s）", _WAREHOUSE_ROOT)
        return result
