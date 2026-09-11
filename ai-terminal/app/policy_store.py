"""圆衡 Enkei 外部 AI 终端 - 政策存储（内存 + JSON 落盘 + ETag）"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import config


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


class PolicyStore:
    """按 (symbol, timeframe) 保存最新政策与历史，落盘 data/policies/。线程安全。"""

    def __init__(self, root: Path | None = None):
        self._root = root or config.POLICY_DIR
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._latest: dict[tuple[str, str], dict] = {}   # (symbol,tf) -> policy
        self._etag: dict[tuple[str, str], str] = {}      # (symbol,tf) -> etag
        self._load()

    def _path(self, symbol: str, tf: str) -> Path:
        return self._root / f"{symbol}_{tf}_latest.json"

    def _hist_path(self, symbol: str, tf: str) -> Path:
        return self._root / f"{symbol}_{tf}_history.jsonl"

    def _load(self):
        for f in self._root.glob("*_latest.json"):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
                key = (p.get("symbol", ""), p.get("timeframe", ""))
                if key[0] and key[1]:
                    self._latest[key] = p
                    self._etag[key] = self._compute_etag(p)
            except Exception:
                continue

    @staticmethod
    def _compute_etag(policy: dict) -> str:
        import hashlib
        raw = json.dumps(policy, sort_keys=True, ensure_ascii=False)
        return '"' + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16] + '"'

    def put(self, policy: dict) -> str:
        with self._lock:
            key = (policy["symbol"], policy["timeframe"])
            etag = self._compute_etag(policy)
            self._latest[key] = policy
            self._etag[key] = etag
            self._path(*key).write_text(
                json.dumps(policy, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            # 历史追加
            with open(self._hist_path(*key), "a", encoding="utf-8") as fh:
                fh.write(json.dumps(policy, ensure_ascii=False) + "\n")
            return etag

    def get_current(self, symbol: str, tf: str) -> tuple[dict | None, str | None]:
        """返回 (最新未过期政策, etag)；无有效政策返回 (None, None)。"""
        with self._lock:
            key = (symbol, tf)
            p = self._latest.get(key)
            if p is None:
                return None, None
            exp = _parse_iso(p.get("expires_at", ""))
            if exp is None or exp.tzinfo is None or exp <= _now() or p.get("degraded") in ("stale", "invalid"):
                return None, self._etag.get(key)
            return p, self._etag.get(key)

    def get_any(self, symbol: str, tf: str) -> dict | None:
        with self._lock:
            return self._latest.get((symbol, tf))

    def get_latest(self, symbol: str, tf: str) -> tuple[dict | None, str | None]:
        """返回最新政策与其 etag（不过期过滤）。无记录返回 (None, None)。"""
        with self._lock:
            key = (symbol, tf)
            p = self._latest.get(key)
            if p is None:
                return None, None
            return p, self._etag.get(key)

    def history(self, symbol: str, tf: str, limit: int = 50) -> list[dict]:
        path = self._hist_path(symbol, tf)
        if not path.exists():
            return []
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines()[-limit:]:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
        return rows

    def all_latest(self) -> dict[str, dict]:
        with self._lock:
            return {f"{s}_{tf}": p for (s, tf), p in self._latest.items()}
