# -*- coding: utf-8 -*-
"""圆衡 Enkei 历史数据仓（P2）

把行情桥(8788)的 OHLCV 历史数据增量同步到本地 CSV 数据仓：
  data/warehouse/{SYMBOL}/{TIMEFRAME}.csv
字段：time, open, high, low, close

幂等 / 增量：
  - 按 time 去重，仅追加新 bar
  - 维护仅追加的 ledger（warehouse.log）记录每次同步的来源、条数、latest_bar_time

用法：
  python enkei_warehouse.py sync                # 同步默认组合(USDJPY/EURUSD/EURJPY M5/M15/H1)
  python enkei_warehouse.py sync --all          # 全标的全周期
  python enkei_warehouse.py summary             # 数据仓概览
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import time
from pathlib import Path

from enkei_adapter import EnkeiMarketAdapter, SUPPORTED_SYMBOLS, SUPPORTED_TIMEFRAMES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logger = logging.getLogger("enkei.warehouse")

DEFAULT_SYMBOLS = ("USDJPY", "EURUSD", "EURJPY")
DEFAULT_TIMEFRAMES = ("M5", "M15", "H1")
SYNC_LIMIT = 5000  # 单次每对最多拉取 bar 数（历史深）
_PADDING = 0


class Warehouse:
    def __init__(self, root: Path, base_url: str = "http://127.0.0.1:8788"):
        self.root = root
        self.adapter = EnkeiMarketAdapter(base_url)

    def _csv_path(self, symbol: str, timeframe: str) -> Path:
        return self.root / symbol.upper() / f"{timeframe.upper()}.csv"

    def load_existing(self, symbol: str, timeframe: str) -> dict[int, list[float]]:
        """读取现有 CSV -> {time: [o,h,l,c]}，缺失文件返回空。"""
        path = self._csv_path(symbol, timeframe)
        out: dict[int, list[float]] = {}
        if not path.exists():
            return out
        with path.open("r", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                try:
                    t = int(row["time"])
                    out[t] = [float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])]
                except (KeyError, ValueError):
                    continue
        return out

    def sync_pair(self, symbol: str, timeframe: str, limit: int = SYNC_LIMIT) -> dict:
        bars, meta = self.adapter.fetch_history(symbol, timeframe, limit)
        existing = self.load_existing(symbol, timeframe)
        added = 0
        for b in bars:
            t = int(b["time"])
            if t not in existing:
                existing[t] = [float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"])]
                added += 1
        if existing:
            path = self._csv_path(symbol, timeframe)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("w", encoding="utf-8", newline="") as fh:
                writer = csv.writer(fh)
                writer.writerow(["time", "open", "high", "low", "close"])
                for t in sorted(existing):
                    o, h, l, c = existing[t]
                    writer.writerow([t, o, h, l, c])
        # ledger
        ledger = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "symbol": symbol.upper(),
            "timeframe": timeframe.upper(),
            "fetched_bars": len(bars),
            "added_bars": added,
            "total_bars": len(existing),
            "latest_bar_time": meta.get("latest_bar_time"),
            "latest_close": bars[-1]["close"] if bars else None,
        }
        self._append_ledger(ledger)
        logger.info("sync %s %s: +%d new, total=%d, latest=%s", symbol, timeframe, added, len(existing), ledger["latest_bar_time"])
        return ledger

    def _append_ledger(self, rec: dict):
        path = self.root / "warehouse.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def sync(self, symbols, timeframes) -> list[dict]:
        out = []
        for sym in symbols:
            for tf in timeframes:
                try:
                    out.append(self.sync_pair(sym, tf))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("skip %s %s: %s", sym, tf, exc)
        return out

    def summary(self) -> dict:
        rows = []
        for path in sorted(self.root.glob("*/*.csv")):
            symbol, timeframe = path.parent.name, path.stem
            n = sum(1 for _ in path.open("r", encoding="utf-8"))
            rows.append({"symbol": symbol, "timeframe": timeframe, "bars": max(n - 1, 0)})
        return {"warehouse_dir": str(self.root), "pairs": rows}


def main():
    parser = argparse.ArgumentParser(description="Enkei 历史数据仓")
    parser.add_argument("action", choices=["sync", "summary"])
    parser.add_argument("--all", action="store_true", help="全标的全周期同步")
    parser.add_argument("--root", default="data/warehouse")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent / args.root
    wh = Warehouse(root)
    if args.action == "summary":
        print(json.dumps(wh.summary(), ensure_ascii=False, indent=2))
        return
    symbols = list(SUPPORTED_SYMBOLS) if args.all else list(DEFAULT_SYMBOLS)
    timeframes = list(SUPPORTED_TIMEFRAMES) if args.all else list(DEFAULT_TIMEFRAMES)
    recs = wh.sync(symbols, timeframes)
    print(json.dumps(wh.summary(), ensure_ascii=False, indent=2))
    print(f"本轮同步 {len(recs)} 组，新增 {sum(r['added_bars'] for r in recs)} 根 K 线")


if __name__ == "__main__":
    main()
