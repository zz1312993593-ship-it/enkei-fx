"""圆衡 Enkei 市场专项追踪服务。

研究报告不是 LibreChat 聊天记录的副本，而是本机持久化的、可过期的证据快照。
它由统一分析体生成，并在后续 M5/M15 判断时按品种压缩注入上下文。
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import statistics
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from . import gateway as gateway_mod
from . import config
from .news import store as news_store
from .policy_store import PolicyStore
from .data_quality import market_errors, report_errors

log = logging.getLogger("enkei.research")

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "research"
TOPICS_FILE = DATA_DIR / "topics.json"
REPORTS_FILE = DATA_DIR / "reports.json"
TRIGGERS_FILE = DATA_DIR / "market-triggers.json"
MAX_REPORTS = 240
MAX_TRIGGERS = 500
MAX_EVENTS_PER_TOPIC = 24
SYMBOL_RE = re.compile(r"^[A-Z0-9]{3,12}$")

# Shipped as an opt-in starter library.  Stable IDs make each user's enabled
# choices durable in topics.json across restarts and update packages.
RESEARCH_PRESETS = (
    {"id": "preset-usdjpy", "symbol": "USDJPY", "name": "美元/日元 · 央行、利差与风险情绪", "interval_minutes": 15, "volatility_pips": 35},
    {"id": "preset-eurusd", "symbol": "EURUSD", "name": "欧元/美元 · 欧美政策差与美元周期", "interval_minutes": 30, "volatility_pips": 30},
    {"id": "preset-gbpusd", "symbol": "GBPUSD", "name": "英镑/美元 · 英国通胀与央行路径", "interval_minutes": 30, "volatility_pips": 35},
    {"id": "preset-eurjpy", "symbol": "EURJPY", "name": "欧元/日元 · ECB/BOJ 政策差", "interval_minutes": 30, "volatility_pips": 40},
    {"id": "preset-gbpjpy", "symbol": "GBPJPY", "name": "英镑/日元 · 风险偏好与套息交易", "interval_minutes": 30, "volatility_pips": 50},
)

# A general news feed is intentionally broad for the terminal's news page.
# A saved market-research report is stricter: unrelated equities or another
# currency's inflation print must never make a USD/JPY report look evidenced.
SYMBOL_SIDES = {
    "USDJPY": (("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债"), ("jpy", "yen", "日元", "boj", "bank of japan", "jgb", "日本央行")),
    "EURUSD": (("eur", "euro", "欧元", "ecb"), ("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债")),
    "GBPUSD": (("gbp", "pound", "sterling", "英镑", "boe"), ("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债")),
    "AUDUSD": (("aud", "aussie", "澳元", "rba"), ("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债")),
    "USDCAD": (("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债"), ("cad", "loonie", "canadian", "加元", "boc")),
    "USDCHF": (("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债"), ("chf", "swiss", "franc", "瑞郎", "snb")),
    "NZDUSD": (("nzd", "kiwi", "新西兰元", "rbnz"), ("usd", "dollar", "美元", "fed", "fomc", "treasury", "美债")),
    "EURJPY": (("eur", "euro", "欧元", "ecb"), ("jpy", "yen", "日元", "boj", "bank of japan", "jgb", "日本央行")),
    "GBPJPY": (("gbp", "pound", "sterling", "英镑", "boe"), ("jpy", "yen", "日元", "boj", "bank of japan", "jgb", "日本央行")),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _safe_text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _safe_list(value: object) -> list:
    """模型输出允许为 null/对象/字符串，报告落盘前统一收窄为数组。"""
    return value if isinstance(value, list) else []


def _topic_id(symbol: str) -> str:
    return f"topic-{symbol.lower()}-{uuid.uuid4().hex[:6]}"


def _evidence_score(item: dict, symbol: str) -> int:
    """Return 0-3 for source evidence that is actually about this symbol."""
    text = " ".join(str(item.get(key) or "") for key in ("title", "display_title", "body", "ai_summary")).lower()
    compact = re.sub(r"[^a-z0-9]", "", text)
    if symbol.lower() in compact:
        return 3
    sides = SYMBOL_SIDES.get(symbol)
    if not sides:
        # Unknown instruments are allowed, but must name the instrument rather
        # than borrowing generic macro stories.
        return 0
    left, right = sides
    left_hit = any(term in text for term in left)
    right_hit = any(term in text for term in right)
    if left_hit and right_hit:
        return 3
    # A policy-side central-bank story is still a usable direct driver; a bare
    # mention of a currency is not enough to qualify as research evidence.
    policy_terms = ("fed", "fomc", "ecb", "boj", "boe", "rba", "boc", "snb", "rbnz", "central bank", "央行", "利率", "inflation", "cpi", "就业", "nonfarm")
    return 2 if (left_hit or right_hit) and any(term in text for term in policy_terms) else 0


class ResearchService:
    """独立于 UI 的研究任务、记忆库和自动触发器。

    该服务只读新闻与政策；没有券商、订单或账户凭据的访问能力。
    """

    def __init__(self) -> None:
        self._store: PolicyStore | None = None
        self._topics: list[dict] = []
        self._reports: list[dict] = []
        self._triggers: list[dict] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._running_topics: set[str] = set()
        self._urgent_callback = None
        # Latest read-only market packets received from the MT4 bridge. They are
        # runtime snapshots (not durable truth) and are separated by timeframe.
        self._market_snapshots: dict[str, dict[str, dict]] = {}
        self._load()

    def configure(self, policy_store: PolicyStore, urgent_callback=None) -> None:
        self._store = policy_store
        self._urgent_callback = urgent_callback

    def _load(self) -> None:
        try:
            if TOPICS_FILE.exists():
                data = json.loads(TOPICS_FILE.read_text(encoding="utf-8"))
                self._topics = [x for x in data.get("topics", []) if isinstance(x, dict)][:80]
            if REPORTS_FILE.exists():
                data = json.loads(REPORTS_FILE.read_text(encoding="utf-8"))
                self._reports = [x for x in data.get("reports", []) if isinstance(x, dict)][:MAX_REPORTS]
            if TRIGGERS_FILE.exists():
                data = json.loads(TRIGGERS_FILE.read_text(encoding="utf-8"))
                self._triggers = [x for x in data.get("triggers", []) if isinstance(x, dict)][:MAX_TRIGGERS]
        except Exception as exc:
            log.warning("research cache unreadable: %s", exc)
            self._topics, self._reports = [], []
        existing_ids = {str(item.get("id") or "") for item in self._topics}
        for preset in RESEARCH_PRESETS:
            if preset["id"] in existing_ids:
                continue
            self._topics.append({
                **preset, "preset": True, "enabled": False, "language": "zh",
                "events": [], "last_run_at": None, "last_trigger": None,
                "last_observed_price": None, "last_observed_at": None,
                "updated_at": _iso(),
            })
        # Persist the starter library once. Later updates preserve each user's
        # enabled state because existing stable IDs always win.
        self._save()

    def _save(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            TOPICS_FILE.write_text(json.dumps({"topics": self._topics, "updated_at": _iso()}, ensure_ascii=False, indent=2), encoding="utf-8")
            REPORTS_FILE.write_text(json.dumps({"reports": self._reports[:MAX_REPORTS], "updated_at": _iso()}, ensure_ascii=False), encoding="utf-8")
            TRIGGERS_FILE.write_text(json.dumps({"triggers": self._triggers[:MAX_TRIGGERS], "updated_at": _iso()}, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            log.warning("research cache save failed: %s", exc)

    @staticmethod
    def _normalise_topic(payload: dict, existing: dict | None = None) -> dict:
        symbol = _safe_text(payload.get("symbol", existing.get("symbol", "") if existing else ""), 12).upper().replace("/", "")
        if not SYMBOL_RE.fullmatch(symbol):
            raise ValueError("symbol 需为 3–12 位大写字母或数字，例如 USDJPY")
        interval = int(payload.get("interval_minutes", existing.get("interval_minutes", 60) if existing else 60))
        interval = max(5, min(interval, 1440))
        volatility = float(payload.get("volatility_pips", existing.get("volatility_pips", 45) if existing else 45))
        volatility = max(1.0, min(volatility, 2000.0))
        language = payload.get("language", existing.get("language", "zh") if existing else "zh")
        language = language if language in ("zh", "ja", "en") else "zh"
        events = payload.get("events", existing.get("events", []) if existing else [])
        events = [x for x in events if isinstance(x, dict)][:MAX_EVENTS_PER_TOPIC]
        return {
            "id": existing.get("id") if existing else _topic_id(symbol),
            "preset": bool(existing.get("preset")) if existing else False,
            "symbol": symbol,
            "name": _safe_text(payload.get("name", existing.get("name", symbol) if existing else symbol), 60) or symbol,
            "enabled": bool(payload.get("enabled", existing.get("enabled", True) if existing else True)),
            "language": language,
            "interval_minutes": interval,
            "volatility_pips": volatility,
            "events": events,
            "last_run_at": existing.get("last_run_at") if existing else None,
            "last_trigger": existing.get("last_trigger") if existing else None,
            "last_observed_price": existing.get("last_observed_price") if existing else None,
            "last_observed_at": existing.get("last_observed_at") if existing else None,
            "updated_at": _iso(),
        }

    async def topics(self) -> list[dict]:
        async with self._lock:
            return copy.deepcopy(self._topics)

    async def upsert_topic(self, payload: dict, topic_id: str | None = None) -> dict:
        async with self._lock:
            index = next((i for i, item in enumerate(self._topics) if item.get("id") == topic_id), None)
            existing = self._topics[index] if index is not None else None
            topic = self._normalise_topic(payload, existing)
            # 每个品种只有一个专题，避免多个定时器重复花费额度。
            duplicate = next((item for item in self._topics if item.get("symbol") == topic["symbol"] and item.get("id") != topic.get("id")), None)
            if duplicate:
                raise ValueError(f"{topic['symbol']} 已有专题，请修改现有专题")
            if index is None:
                self._topics.insert(0, topic)
            else:
                self._topics[index] = topic
            self._save()
            return copy.deepcopy(topic)

    async def delete_topic(self, topic_id: str) -> bool:
        async with self._lock:
            before = len(self._topics)
            self._topics = [item for item in self._topics if item.get("id") != topic_id]
            changed = len(self._topics) != before
            if changed:
                self._save()
            return changed

    async def reports(self, symbol: str | None = None, limit: int = 20) -> list[dict]:
        async with self._lock:
            rows = [item for item in self._reports if not symbol or item.get("symbol") == symbol]
            result = copy.deepcopy(rows[:max(1, min(limit, 100))])
            for row in result:
                if row.get("status") == "evidence_ready" and not self._usable_report(row):
                    row["status"] = "insufficient_sources"
                    row["source_assessment"] = "报告已过期、缺少行情来源或内容不完整；仅供历史审计，不进入判断上下文。"
            return result

    async def triggers(self, symbol: str | None = None, limit: int = 50) -> list[dict]:
        async with self._lock:
            rows = [item for item in self._triggers if not symbol or item.get("symbol") == symbol]
            return copy.deepcopy(rows[:max(1, min(limit, 200))])

    @staticmethod
    def _new_trigger(*, kind: str, symbol: str, reason: str, severity: str,
                     source_timeframe: str, source_bar_time: str | None,
                     topic_id: str | None = None, event: dict | None = None) -> dict:
        now = _iso()
        return {"id": f"trigger-{uuid.uuid4().hex[:12]}", "kind": kind, "symbol": symbol,
                "topic_id": topic_id, "reason": reason, "severity": severity,
                "status": "detected", "detected_at": now, "source_timeframe": source_timeframe,
                "source_bar_time": source_bar_time, "m1_evidence_only": True,
                "formal_decision_timeframe": "M5", "normal_policy_suspended": True,
                "event": event or None, "report_id": None, "m5_confirmation_report_id": None,
                "timeline": [{"at": now, "stage": "detected"}]}

    async def _update_trigger(self, trigger_id: str, stage: str, **fields) -> None:
        async with self._lock:
            row = next((item for item in self._triggers if item.get("id") == trigger_id), None)
            if not row:
                return
            row.update(fields); row["status"] = stage
            row.setdefault("timeline", []).append({"at": _iso(), "stage": stage})
            self._save()

    @staticmethod
    def _usable_report(report: dict) -> bool:
        expires = _parse_time(report.get("valid_until"))
        return bool(report.get("status") == "evidence_ready" and expires and expires > _now()
                    and report.get("market_context") and not report_errors(report))

    async def _persist_report(self, topic: dict, report: dict) -> dict:
        """Persist every attempt, including evidence-gated non-reports, for audit."""
        async with self._lock:
            self._reports = [report, *[item for item in self._reports if item.get("id") != report["id"]]][:MAX_REPORTS]
            for index, item in enumerate(self._topics):
                if item.get("id") == topic["id"]:
                    item.update({"last_run_at": report["generated_at"], "last_trigger": report["trigger"], "updated_at": _iso()})
                    self._topics[index] = item
                    break
            self._save()
        return copy.deepcopy(report)

    async def context_for(self, symbol: str) -> str:
        """给统一分析体的短上下文；只注入未过期、证据就绪的报告。"""
        details = await self.context_details_for(symbol)
        return str(details.get("context") or "")

    async def context_details_for(self, symbol: str) -> dict:
        """返回实际注入的专项报告及其审计身份，供分析会话向用户展示。"""
        async with self._lock:
            report = next((item for item in self._reports if item.get("symbol") == symbol and self._usable_report(item)), None)
            if not report:
                return {}
            expires = _parse_time(report.get("valid_until"))
            if not expires or expires <= _now():
                return {}
            thesis = report.get("thesis") if isinstance(report.get("thesis"), dict) else {}
            levels = report.get("key_levels") if isinstance(report.get("key_levels"), list) else []
            level_text = "；".join(f"{_safe_text(item.get('label'), 32)}={item.get('price')}" for item in levels[:4] if isinstance(item, dict))
            context = (
                f"【市场专项追踪 {symbol} / {report.get('id')}】生成于 {report.get('generated_at')}，有效至 {report.get('valid_until')}。\n"
                f"短线：{_safe_text(thesis.get('short_bias'), 16)}；中期：{_safe_text(thesis.get('mid_bias'), 16)}；"
                f"置信度：{thesis.get('confidence', 0)}。\n"
                f"结论：{_safe_text(thesis.get('summary'), 420)}\n"
                f"关键价位：{level_text or '未提供'}。\n"
                "该研究是上下文，不是无条件订单；若与最新报价或本周期结构冲突，优先 wait 并重新评估。"
            )
            return {
                "context": context,
                "report_id": report.get("id"),
                "generated_at": report.get("generated_at"),
                "valid_until": report.get("valid_until"),
            }

    def _policy_context(self, symbol: str) -> list[dict]:
        if not self._store:
            return []
        rows = []
        for timeframe in ("M5", "M15"):
            policy, _ = self._store.get_current(symbol, timeframe)
            if policy:
                rows.append({
                    "timeframe": timeframe,
                    "action_bias": policy.get("action_bias"),
                    "regime": policy.get("market_regime"),
                    "confidence": policy.get("confidence"),
                    "rationale": _safe_text(policy.get("rationale_zh"), 280),
                    "generated_at": policy.get("generated_at"),
                })
        return rows

    def _market_context(self, symbol: str) -> dict:
        """Return a bounded, auditable multi-timeframe packet for research."""
        frames = self._market_snapshots.get(symbol, {})
        output: dict[str, dict] = {}
        for timeframe, summary in frames.items():
            packet = {key: value for key, value in summary.items() if key != "captured_at"}
            if market_errors(packet):
                continue
            quote = summary.get("quote") if isinstance(summary.get("quote"), dict) else {}
            features = summary.get("features") if isinstance(summary.get("features"), dict) else {}
            bars = summary.get("bars") if isinstance(summary.get("bars"), list) else []
            output[timeframe] = {
                "captured_at": summary.get("captured_at"),
                "generated_at": summary.get("generated_at"),
                "quote": {key: quote.get(key) for key in ("bid", "ask", "spread_pips", "received_at")},
                "features": {key: features.get(key) for key in ("ema_fast", "ema_slow", "momentum", "recent_high", "recent_low", "range_pips")},
                "bar_count": len(bars),
                "recent_bars": [
                    {key: bar.get(key) for key in ("time", "open", "high", "low", "close", "volume")}
                    for bar in bars[-12:] if isinstance(bar, dict)
                ],
            }
        return output

    async def _refresh_market_context(self, symbol: str) -> None:
        """Pull a bounded read-only packet from the local MT4 bridge.

        Research used to receive price context only after a user pressed the
        separate "LLM assessment" button.  Scheduled reports therefore had
        fresh news but an empty market_context.  The research service may read
        the loopback bridge directly; it still has no account or order access.
        """
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                snapshot_response = await client.get("http://127.0.0.1:8788/api/snapshot")
                snapshot_response.raise_for_status()
                snapshot = snapshot_response.json()
                quote = next((row for row in snapshot.get("quotes", []) if row.get("symbol") == symbol), None)
                if not isinstance(quote, dict) or float(snapshot.get("age_ms", 1e12)) > 10_000:
                    return
                # MT4 tick_time is broker-server time, not UTC.  Prefer the
                # bridge's calibrated GMT epoch; otherwise apply its explicit
                # history/time adjustment before ISO conversion.
                gmt_epoch = float(snapshot.get("gmt_epoch") or 0)
                tick_time = float(quote.get("tick_time") or 0)
                adjustment = float(snapshot.get("history_time_adjustment_seconds") or 0)
                received_epoch = gmt_epoch if gmt_epoch > 0 else tick_time + adjustment
                received_at = _iso(datetime.fromtimestamp(received_epoch, timezone.utc)) if received_epoch > 0 else ""
                digits = int(quote.get("digits", 5) or 5)
                pip = 0.01 if digits in (2, 3) else 0.0001
                for timeframe in ("M5", "M15"):
                    history_response = await client.get(
                        "http://127.0.0.1:8788/api/history",
                        params={"symbol": symbol, "timeframe": timeframe, "limit": 80},
                    )
                    history_response.raise_for_status()
                    history = history_response.json()
                    raw_bars = history.get("bars") if isinstance(history.get("bars"), list) else []
                    raw_bars = raw_bars[-60:]
                    if len(raw_bars) < 20 or history.get("clock", {}).get("status") == "unresolved":
                        continue
                    closes = [float(row["close"]) for row in raw_bars]

                    def ema(period: int) -> float:
                        value = closes[0]
                        weight = 2 / (period + 1)
                        for close in closes[1:]:
                            value = close * weight + value * (1 - weight)
                        return value

                    recent = raw_bars[-20:]
                    recent_high = max(float(row["high"]) for row in recent)
                    recent_low = min(float(row["low"]) for row in recent)
                    packet = {
                        "version": "enkei-market-summary/v1",
                        "generated_at": _iso(),
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "quote": {
                            "bid": float(quote["bid"]), "ask": float(quote["ask"]),
                            "spread_pips": round((float(quote["ask"]) - float(quote["bid"])) / pip, 2),
                            "received_at": received_at,
                        },
                        "features": {
                            "ema_fast": ema(20), "ema_slow": ema(50),
                            "momentum": closes[-1] - closes[-6],
                            "recent_high": recent_high, "recent_low": recent_low,
                            "range_pips": (recent_high - recent_low) / pip,
                        },
                        "bars": [{
                            "time": _iso(datetime.fromtimestamp(float(row["time"]), timezone.utc)),
                            "open": float(row["open"]), "high": float(row["high"]),
                            "low": float(row["low"]), "close": float(row["close"]),
                        } for row in raw_bars],
                        "execution_context": {"selected_rule_model": "research-only", "positions": [], "previous_policy": None},
                    }
                    packet_errors = market_errors(packet)
                    if not packet_errors:
                        packet["captured_at"] = _iso()
                        self._market_snapshots.setdefault(symbol, {})[timeframe] = packet
                    else:
                        log.warning(
                            "本地行情上下文被质量门拒绝 symbol=%s timeframe=%s errors=%s",
                            symbol, timeframe, packet_errors[:6],
                        )
        except (httpx.HTTPError, TypeError, ValueError, KeyError) as exc:
            log.warning("本地行情上下文刷新失败 symbol=%s error=%s", symbol, type(exc).__name__)

    def latest_packet(self, symbol: str, timeframe: str) -> dict | None:
        packet = copy.deepcopy(self._market_snapshots.get(symbol, {}).get(timeframe))
        if packet:
            packet.pop("captured_at", None)
            if not market_errors(packet):
                return packet
        return None

    async def run_topic(self, topic_id: str, trigger: str = "manual", language: str | None = None) -> dict:
        async with self._lock:
            topic = next((copy.deepcopy(item) for item in self._topics if item.get("id") == topic_id), None)
            if not topic:
                raise ValueError("未找到研究专题")
            if language in ("zh", "ja", "en") and topic.get("language") != language:
                topic["language"] = language
                for item in self._topics:
                    if item.get("id") == topic_id:
                        item["language"] = language
                        break
                self._save_topics()
            if topic_id in self._running_topics:
                return {"status": "running", "topic_id": topic_id}
            self._running_topics.add(topic_id)
        try:
            return await self._generate(topic, trigger)
        finally:
            async with self._lock:
                self._running_topics.discard(topic_id)

    async def _generate(self, topic: dict, trigger: str) -> dict:
        symbol, language = topic["symbol"], topic["language"]
        cfg = gateway_mod.load_gateway_config()
        provider_cfg = config.load_provider_config()
        route = (provider_cfg.get("routing") or {}).get("M15") or {}
        cloud_name = str(route.get("provider") or "").lower()
        cloud_role = str(route.get("model_role") or "deep")
        cloud_cfg = (provider_cfg.get("providers") or {}).get(cloud_name) or {}
        use_cloud = bool(cloud_name and cloud_name != "ollama" and cloud_cfg.get("enabled") and cloud_cfg.get("api_key"))
        agent_id = cfg.agent_for("M15")
        use_librechat = bool(cfg.is_librechat_ready() and agent_id)
        use_local = bool(getattr(cfg, "local_fallback_enabled", False) and getattr(cfg, "ollama_fallback_model", ""))
        if not use_librechat and not use_cloud and not use_local:
            raise RuntimeError("尚未配置可用的 LibreChat Agent 或本地备用模型")
        news_items = await news_store.relevant_items(symbol, limit=8, language=language)
        market_context = self._market_context(symbol)
        if not market_context:
            await self._refresh_market_context(symbol)
            market_context = self._market_context(symbol)
        qualified_items = [item for item in news_items if _evidence_score(item, symbol) >= 2]
        evidence = [
            {"id": f"news-{index}", "title": _safe_text(item.get("display_title") or item.get("title"), 240),
             "summary": _safe_text(item.get("ai_summary") or item.get("body"), 420), "source": _safe_text(item.get("source"), 48),
             "published": item.get("published"), "url": item.get("link")}
            for index, item in enumerate(qualified_items)
        ]
        now = _now()
        fallback = {
            "zh": {
                "no_head": f"{symbol} 暂无可用专项证据", "no_summary": "当前新闻流和本机行情没有足够证据；本次不调用模型，也不会写入策略上下文。",
                "no_risk": "相关行情或新闻证据不足，继续等待下一次刷新。", "no_check": "刷新行情与新闻源后重试", "no_assess": f"已筛查 {len(news_items)} 条候选新闻，但缺少足够的 {symbol} 直接证据；已阻止无上下文生成。",
                "bad_head": f"{symbol} 等待结构化分析结果", "bad_summary": "统一分析体本次未返回可校验的结构化结果；系统没有生成方向结论。", "bad_risk": "AI 返回格式不完整，本轮结果不能作为策略依据。", "bad_check": "等待下一次研究后复核", "bad_assess": f"已找到 {len(evidence)} 条直接相关来源，但分析格式不合格，本次被安全降级。",
            },
            "ja": {
                "no_head": f"{symbol} 利用可能な調査証拠なし", "no_summary": "ニュースとローカル市場データの証拠が不足しているため、モデルを呼び出さず戦略コンテキストにも追加しません。",
                "no_risk": "関連する市場・ニュース証拠が不足しています。", "no_check": "市場データとニュースを更新して再試行", "no_assess": f"候補ニュース {len(news_items)} 件を確認しましたが、{symbol} の直接証拠が不足しています。",
                "bad_head": f"{symbol} 構造化分析を待機中", "bad_summary": "統合分析体から検証可能な構造化結果が返らなかったため、方向判断は生成していません。", "bad_risk": "AI の出力形式が不完全なため戦略判断には使用できません。", "bad_check": "次回の調査で再確認", "bad_assess": f"直接関連する情報源 {len(evidence)} 件はありますが、出力形式の検証に失敗しました。",
            },
            "en": {
                "no_head": f"No usable research evidence for {symbol}", "no_summary": "The news feed and local market data do not provide enough evidence, so no model call or strategy context was produced.",
                "no_risk": "Relevant market or news evidence is insufficient.", "no_check": "Refresh market data and news, then retry", "no_assess": f"Reviewed {len(news_items)} candidate items, but direct evidence for {symbol} was insufficient.",
                "bad_head": f"{symbol} is awaiting structured analysis", "bad_summary": "The unified analyst did not return a valid structured result, so no directional conclusion was produced.", "bad_risk": "The AI output format was incomplete and cannot be used as strategy evidence.", "bad_check": "Recheck on the next research run", "bad_assess": f"Found {len(evidence)} directly relevant sources, but the output failed structural validation.",
            },
        }[language]
        if not evidence and not market_context:
            # Do not spend an Agent call to turn an empty or unrelated feed
            # into a plausible report.  This audit row explains why nothing was
            # injected and lets the scheduler retry after the next refresh.
            report = {
                "version": "enkei-research-report/v2", "protocol_version": "enkei-analysis-protocol/v2", "id": f"research-{uuid.uuid4().hex[:12]}", "topic_id": topic["id"],
                "symbol": symbol, "topic_name": topic["name"], "trigger": trigger, "status": "insufficient_sources",
                "generated_at": _iso(now), "valid_until": _iso(now), "headline": fallback["no_head"],
                "thesis": {"short_bias": "wait", "mid_bias": "wait", "confidence": 0, "summary": fallback["no_summary"]},
                "drivers": [], "key_levels": [], "risks": [fallback["no_risk"]],
                "next_checks": [fallback["no_check"]],
                "source_assessment": fallback["no_assess"],
                "sources": [], "agent": agent_id, "provider": "local-evidence-gate", "policy_context": self._policy_context(symbol), "market_context": {},
                "data_status": {"report_time": _iso(now), "source_times": {}, "realtime": False, "missing": ["market_context", "direct_news_evidence"], "stale": []},
                "related_markets": [], "event_assessment": [], "evidence_balance": {"bull": [], "bear": [], "wait": [fallback["no_risk"]], "conflicts": [], "dominant": "wait"},
                "logic_consistency": {"status": "unknown", "explanation": fallback["no_assess"]}, "scenarios": {},
                "final_judgment": {"action": "wait", "confidence": 0, "valid_until": _iso(now), "no_chase_zone": [], "recheck_conditions": [fallback["no_check"]], "watch_variables": []},
                "change_from_previous": {"status": "insufficient_evidence", "previous_still_valid": None},
                "verified_facts": [], "inferences": [], "system_recommendations": [fallback["no_risk"]],
            }
            log.info("专题报告跳过 symbol=%s trigger=%s reason=no_direct_evidence", symbol, trigger)
            return await self._persist_report(topic, report)
        messages = [
            {"role": "system", "content": "你是圆衡统一 AI 分析体的市场专项研究模块。只输出合法 JSON；所有数字只能来自 market_context、evidence 或 policy_context，未提供则写‘未知’，不得杜撰实时行情。必须先用实时报价、多周期K线与技术特征判断市场结构，再用新闻解释驱动与风险；新闻不得替代价格证据。必须严格区分 verified_facts（已验证事实）、inferences（AI推断）与 system_recommendations（系统建议），不得把预测写成事实。研究报告只供策略上下文和风险判断，不直接下单。所有用户可见文字必须严格使用请求的 language（zh、ja 或 en）；short_bias 和 mid_bias 只能保留 long、short 或 wait。"},
            {"role": "user", "content": json.dumps({
                "task": "market_research_report", "symbol": symbol, "language": language, "trigger": trigger,
                "requirements": {
                    "headline": "不超过60字", "thesis": "含 short_bias(long|short|wait)、mid_bias(long|short|wait)、confidence(0-100)、summary；summary需解释价格、利差/央行、风险情绪和新闻之间的一致或矛盾",
                    "content_language": language,
                    "drivers": "3至5项字符串，逐项引用 market_context、news_evidence 或 policy_context，并区分主驱动与反向压力", "key_levels": "数组，每项必须是 {label:字符串, price:正数}；只使用输入中的真实价格，并标注突破、失效或观察意义",
                    "risks": "最多4项，必须包含重大事件、反向情景或数据缺口", "next_checks": "最多4项，写明下次复核触发条件和需要监测的价格行为", "source_assessment": "说明证据质量、冲突和未知项；不得把推断写成事实",
                    "trigger_handling": "trigger 为 anomaly 或 volatility 时，明确说明是否存在新闻解释；无匹配新闻则标记为异常价格行为并给出紧急复核条件",
                    "data_status": "列出报告时间、各输入更新时间、来源、当前价格、涨跌、点差、实时性、缺失及过期项",
                    "related_markets": "列出该品种相关的美元指数、债券收益率、利差、黄金、原油、风险资产和央行预期；输入缺失必须写未知",
                    "event_assessment": "列出已发生/即将发生事件、预期、实际、预期差、方向影响及是否已消化",
                    "evidence_balance": "分别列出多方、空方、观望、矛盾证据和当前占优一方",
                    "logic_consistency": "说明价格与传统宏观逻辑是否一致，背离只作为推断",
                    "scenarios": "包含 base/up/down 三种情景；每项有 trigger、levels、path、risks、invalidation",
                    "final_judgment": "包含 action、confidence、valid_until、no_chase_zone、recheck_conditions、watch_variables",
                    "change_from_previous": "说明数据、逻辑、方向、置信度、关键价格和上次判断有效性的变化",
                },
                "market_context": market_context, "news_evidence": evidence, "policy_context": self._policy_context(symbol),
            }, ensure_ascii=False)},
        ]
        result_provider = "librechat"
        result_model = agent_id
        try:
            if use_librechat:
                result = await gateway_mod.LibreChatClient(cfg).ask_agent(agent_id, messages, timeout=70.0, request_id=f"research_{symbol}_{uuid.uuid4().hex[:8]}")
            elif use_cloud:
                from . import providers as providers_mod
                packet = self.latest_packet(symbol, "M15") or self.latest_packet(symbol, "M5")
                if not packet:
                    raise gateway_mod.GatewayError("missing_market", "专项研究缺少可验证行情")
                news_text = "\n".join(f"- {item['title']}: {item['summary']}" for item in evidence[:6])
                timeout = float((cloud_cfg.get("timeout_seconds") or {}).get(cloud_role, 90))
                provider = providers_mod.build_provider(cloud_name, cloud_cfg)
                result = await provider.analyze_messages(messages, cloud_role, timeout, max_tokens=2200)
                result_provider = cloud_name
                result_model = (cloud_cfg.get("models") or {}).get(cloud_role, cloud_name)
            else:
                payload = {
                    "model": cfg.ollama_fallback_model,
                    "messages": messages,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.2, "num_ctx": 16384, "num_predict": 1024},
                }
                async with httpx.AsyncClient(timeout=120.0) as client:
                    response = await client.post(f"{cfg.ollama_base_url.rstrip('/')}/api/chat", json=payload)
                response.raise_for_status()
                result = gateway_mod._agent_message_text(response.json().get("message", {}))
                from .providers import extract_json
                result = extract_json(result)
                if not isinstance(result, dict):
                    raise gateway_mod.GatewayError("invalid_json", "本地备用模型未返回合法 JSON")
                result_provider = "ollama"
                result_model = cfg.ollama_fallback_model
            token_usage = result.pop("_usage", None) if isinstance(result, dict) else None
            if isinstance(result, dict):
                result.pop("_latency_ms", None)
                result.pop("_request_id", None)
            # The shared decision Agent historically returns its thesis fields
            # at the top level.  Adapt that documented shape into the research
            # contract, while deriving only descriptive sections from the
            # evidence already supplied to the model.
            if isinstance(result, dict) and not isinstance(result.get("thesis"), dict) and any(key in result for key in ("short_bias", "mid_bias", "summary")):
                result = {
                    **result,
                    "headline": _safe_text(result.get("headline") or result.get("summary"), 120) or f"{symbol} 市场专项追踪",
                    "thesis": {
                        "short_bias": result.get("short_bias", "wait"),
                        "mid_bias": result.get("mid_bias", "wait"),
                        "confidence": result.get("confidence", 0),
                        "summary": _safe_text(result.get("summary"), 900) or "统一分析体未提供摘要。",
                    },
                    "drivers": result.get("drivers") if isinstance(result.get("drivers"), list) and result.get("drivers") else [item["title"] for item in evidence[:3]],
                    "key_levels": result.get("key_levels") if isinstance(result.get("key_levels"), list) else [],
                    "risks": result.get("risks") if isinstance(result.get("risks"), list) and result.get("risks") else ["新闻与价格关系需在下一轮行情中继续确认。"],
                    "next_checks": result.get("next_checks") if isinstance(result.get("next_checks"), list) and result.get("next_checks") else ["下一根 M15 完成后复核方向与关键位置。"],
                    "source_assessment": _safe_text(result.get("source_assessment"), 480) or f"统一分析体结合 {len(evidence)} 条新闻证据与本机多周期行情形成判断。",
                }
            # Small local models sometimes return the core thesis correctly but
            # omit secondary display fields. Complete only descriptive fields
            # from audited inputs; never invent a price level or direction.
            if isinstance(result, dict) and isinstance(result.get("thesis"), dict):
                localized = {
                    "zh": {
                        "headline": f"{symbol} 市场专项研究",
                        "summary": "本地分析体已完成市场结构评估；方向与置信度见本报告。",
                        "driver": f"已结合 {len(evidence)} 条审计新闻与本机多周期行情。",
                        "risk": "新闻与价格关系仍需在下一轮行情中复核。",
                        "check": "下一根 M15 完成后复核方向和风险。",
                        "assessment": f"本地分析体使用本机行情和 {len(evidence)} 条直接相关来源完成分析。",
                    },
                    "ja": {
                        "headline": f"{symbol} 市場特別調査",
                        "summary": "ローカル分析体が市場構造を評価しました。方向と確信度は本レポートに表示されます。",
                        "driver": f"監査済みニュース {len(evidence)} 件とローカルの複数時間足データを使用しました。",
                        "risk": "ニュースと価格の関係は次回の市場データで再確認が必要です。",
                        "check": "次の M15 確定後に方向とリスクを再確認します。",
                        "assessment": f"ローカル分析体が市場データと直接関連する情報源 {len(evidence)} 件を分析しました。",
                    },
                    "en": {
                        "headline": f"{symbol} market research",
                        "summary": "The local analyst completed a market-structure assessment; direction and confidence are shown in this report.",
                        "driver": f"Used {len(evidence)} audited news sources and local multi-timeframe market data.",
                        "risk": "The relationship between news and price still requires confirmation in the next market window.",
                        "check": "Recheck direction and risk after the next completed M15 candle.",
                        "assessment": f"The local analyst used local market data and {len(evidence)} directly relevant sources.",
                    },
                }.get(language, {})
                thesis = result["thesis"]
                result["headline"] = _safe_text(result.get("headline"), 120) or localized["headline"]
                thesis["summary"] = _safe_text(thesis.get("summary"), 900) or localized["summary"]
                for key, fallback in (("drivers", localized["driver"]), ("risks", localized["risk"]), ("next_checks", localized["check"])):
                    if not isinstance(result.get(key), list) or not result[key]:
                        result[key] = [fallback]
                if not isinstance(result.get("key_levels"), list):
                    result["key_levels"] = []
                result["source_assessment"] = _safe_text(result.get("source_assessment"), 480) or localized["assessment"]
            validation_errors = report_errors(result)
            if validation_errors:
                # Keep diagnostics structural and bounded: field names and
                # validation reasons are enough to repair an Agent contract,
                # while full model output may contain market/news text.
                result_keys = sorted(str(key) for key in result.keys())[:24] if isinstance(result, dict) else []
                log.warning(
                    "专题结构校验失败 symbol=%s errors=%s keys=%s",
                    symbol, validation_errors[:8], result_keys,
                )
                raise gateway_mod.GatewayError("invalid_json", "专题内容不完整或字段类型无效")
        except gateway_mod.GatewayError as exc:
            if exc.category != "invalid_json":
                raise
            # A provider formatting error must never become a repeating 502.
            # Keep a source audit but deliberately withhold any conclusion and
            # strategy context until a later window returns valid structure.
            report = {
                "version": "enkei-research-report/v2", "protocol_version": "enkei-analysis-protocol/v2", "id": f"research-{uuid.uuid4().hex[:12]}", "topic_id": topic["id"],
                "symbol": symbol, "topic_name": topic["name"], "trigger": trigger, "status": "insufficient_sources",
                "generated_at": _iso(now), "valid_until": _iso(now), "headline": fallback["bad_head"],
                "thesis": {"short_bias": "wait", "mid_bias": "wait", "confidence": 0, "summary": fallback["bad_summary"]},
                "drivers": [], "key_levels": [], "risks": [fallback["bad_risk"]],
                "next_checks": [fallback["bad_check"]],
                "source_assessment": fallback["bad_assess"],
                "sources": [{"id": item["id"], "source": item["source"], "title": item["title"], "display": item["title"], "published": item["published"], "url": item["url"], "link": item["url"]} for item in evidence],
                "agent": agent_id, "provider": "librechat-format-gate", "policy_context": self._policy_context(symbol), "market_context": market_context,
                "data_status": {"report_time": _iso(now), "source_times": {tf: frame.get("generated_at") for tf, frame in market_context.items()}, "realtime": bool(market_context), "missing": ["valid_structured_analysis"], "stale": []},
                "related_markets": [], "event_assessment": [], "evidence_balance": {"bull": [], "bear": [], "wait": [fallback["bad_risk"]], "conflicts": [], "dominant": "wait"},
                "logic_consistency": {"status": "unknown", "explanation": fallback["bad_assess"]}, "scenarios": {},
                "final_judgment": {"action": "wait", "confidence": 0, "valid_until": _iso(now), "no_chase_zone": [], "recheck_conditions": [fallback["bad_check"]], "watch_variables": []},
                "change_from_previous": {"status": "invalid_model_output", "previous_still_valid": None},
                "verified_facts": [], "inferences": [], "system_recommendations": [fallback["bad_risk"]],
            }
            log.warning("专题报告降级 symbol=%s trigger=%s reason=%s", symbol, trigger, exc.category)
            return await self._persist_report(topic, report)
        if not isinstance(result, dict):
            raise RuntimeError("统一分析体未返回结构化专题结果")
        thesis = result.get("thesis") if isinstance(result.get("thesis"), dict) else {}
        confidence = max(0, min(100, float(thesis.get("confidence", 0) or 0)))
        source_rows = [{"id": item["id"], "source": item["source"], "title": item["title"], "display": item["title"], "published": item["published"], "url": item["url"], "link": item["url"]} for item in evidence]
        report = {
            "version": "enkei-research-report/v2", "protocol_version": "enkei-analysis-protocol/v2",
            "id": f"research-{uuid.uuid4().hex[:12]}", "topic_id": topic["id"],
            "symbol": symbol, "topic_name": topic["name"], "trigger": trigger, "status": "evidence_ready" if market_context else "insufficient_sources",
            "generated_at": _iso(now), "valid_until": _iso(now + timedelta(minutes=max(15, min(topic["interval_minutes"] * 2, 240)))),
            "headline": _safe_text(result.get("headline"), 120) or f"{symbol} 市场专项追踪",
            "thesis": {"short_bias": _safe_text(thesis.get("short_bias"), 16) or "wait", "mid_bias": _safe_text(thesis.get("mid_bias"), 16) or "wait", "confidence": round(confidence, 1), "summary": _safe_text(thesis.get("summary"), 900)},
            "drivers": [_safe_text(x, 240) for x in _safe_list(result.get("drivers")) if isinstance(x, str)][:5],
            "key_levels": [x for x in _safe_list(result.get("key_levels")) if isinstance(x, dict)][:8],
            "risks": [_safe_text(x, 240) for x in _safe_list(result.get("risks")) if isinstance(x, str)][:4],
            "next_checks": [_safe_text(x, 240) for x in _safe_list(result.get("next_checks")) if isinstance(x, str)][:4],
            "source_assessment": _safe_text(result.get("source_assessment"), 480), "sources": source_rows,
            "agent": result_model, "model": result_model, "provider": result_provider, "policy_context": self._policy_context(symbol), "market_context": market_context,
            "token_usage": token_usage,
            "data_status": result.get("data_status") if isinstance(result.get("data_status"), dict) else {
                "report_time": _iso(now), "source_times": {tf: frame.get("generated_at") for tf, frame in market_context.items()},
                "realtime": bool(market_context), "missing": [] if market_context else ["market_context"], "stale": []},
            "related_markets": _safe_list(result.get("related_markets")),
            "event_assessment": _safe_list(result.get("event_assessment")),
            "evidence_balance": result.get("evidence_balance") if isinstance(result.get("evidence_balance"), dict) else {
                "bull": [], "bear": [], "wait": [], "conflicts": [], "dominant": "unknown"},
            "logic_consistency": result.get("logic_consistency") if isinstance(result.get("logic_consistency"), dict) else {
                "status": "unknown", "explanation": "输入不足，未验证传统逻辑是否成立。"},
            "scenarios": result.get("scenarios") if isinstance(result.get("scenarios"), dict) else {},
            "final_judgment": result.get("final_judgment") if isinstance(result.get("final_judgment"), dict) else {
                "action": _safe_text(thesis.get("short_bias"), 16) or "wait", "confidence": round(confidence, 1),
                "valid_until": None, "no_chase_zone": [], "recheck_conditions": _safe_list(result.get("next_checks")), "watch_variables": []},
            "change_from_previous": result.get("change_from_previous") if isinstance(result.get("change_from_previous"), dict) else {
                "status": "not_provided", "previous_still_valid": None},
            "verified_facts": _safe_list(result.get("verified_facts")),
            "inferences": _safe_list(result.get("inferences")),
            "system_recommendations": _safe_list(result.get("system_recommendations")),
        }
        report["final_judgment"]["valid_until"] = report["valid_until"]
        if not market_context:
            report["thesis"].update(short_bias="wait", mid_bias="wait", confidence=0)
            report["valid_until"] = _iso(now)
            report["source_assessment"] = "缺少新鲜行情，本报告仅为新闻研究，不注入方向判断。" + report["source_assessment"]
        else:
            # 不让新闻报告存活数小时，而行情已失效。起点是源数据，不是模型完成时间。
            anchors = [_parse_time(frame.get("generated_at")) for frame in market_context.values()]
            expiry = min(at for at in anchors if at) + timedelta(minutes=15)
            report["valid_until"] = _iso(min(expiry, _parse_time(report["valid_until"])))
            if expiry <= _now():
                report["status"] = "insufficient_sources"
                report["thesis"].update(short_bias="wait", mid_bias="wait", confidence=0)
        log.info("专题报告已生成 symbol=%s trigger=%s sources=%d", symbol, trigger, len(source_rows))
        return await self._persist_report(topic, report)

    async def observe_market(self, summary: dict) -> None:
        """市场摘要到达时检查用户设定的大幅波动阈值；不直接创建订单。"""
        if market_errors(summary):
            return
        symbol = _safe_text(summary.get("symbol"), 12).upper()
        quote = summary.get("quote") if isinstance(summary.get("quote"), dict) else {}
        price = float(quote.get("bid", 0) or 0)
        spread = float(quote.get("spread_pips", 0) or 0)
        if not symbol or price <= 0:
            return
        timeframe = _safe_text(summary.get("timeframe"), 8).upper() or "UNKNOWN"
        packet = copy.deepcopy(summary)
        packet["captured_at"] = _iso()
        self._market_snapshots.setdefault(symbol, {})[timeframe] = packet
        candidates: list[tuple[str, str]] = []
        bars = summary.get("bars") if isinstance(summary.get("bars"), list) else []
        pip_factor = 100.0 if symbol.endswith("JPY") else 10000.0
        abnormal_range = False
        if len(bars) >= 12:
            valid_ranges = [
                (float(row.get("high")) - float(row.get("low"))) * pip_factor
                for row in bars[-21:-1]
                if isinstance(row, dict) and isinstance(row.get("high"), (int, float)) and isinstance(row.get("low"), (int, float))
            ]
            latest = bars[-1] if isinstance(bars[-1], dict) else {}
            latest_range = (float(latest.get("high", 0)) - float(latest.get("low", 0))) * pip_factor
            median_range = statistics.median(valid_ranges) if valid_ranges else 0
            abnormal_range = median_range > 0 and latest_range >= max(8.0, median_range * 2.8)
        async with self._lock:
            if timeframe == "M5":
                current_bar_time = str((bars[-1] if bars and isinstance(bars[-1], dict) else {}).get("time") or "")
                for active_trigger in self._triggers:
                    if (active_trigger.get("symbol") == symbol and active_trigger.get("status") == "awaiting_m5"
                            and current_bar_time and current_bar_time != active_trigger.get("source_bar_time")):
                        candidates.append((str(active_trigger.get("topic_id") or ""), f"m5-confirmation:{active_trigger['id']}"))
                        active_trigger["status"] = "m5_confirmation_queued"
                        active_trigger.setdefault("timeline", []).append({"at": _iso(), "stage": "m5_confirmation_queued"})
            for item in self._topics:
                if not item.get("enabled") or item.get("symbol") != symbol:
                    continue
                prior = item.get("last_observed_price")
                prior_spread = item.get("last_observed_spread")
                prior_at = _parse_time(item.get("last_observed_at"))
                observation_gap = (_now() - prior_at).total_seconds() if prior_at else 0
                item["last_observed_price"], item["last_observed_spread"], item["last_observed_at"] = price, spread, _iso()
                anomaly_reason = None
                if spread > 0 and isinstance(prior_spread, (int, float)) and float(prior_spread) > 0 and spread >= max(3.0, float(prior_spread) * 2.5):
                    anomaly_reason = f"anomaly:spread-widening:{float(prior_spread):.1f}->{spread:.1f}pips"
                elif prior_at and observation_gap >= 180:
                    anomaly_reason = f"anomaly:data-recovered-after:{int(observation_gap)}s"
                if isinstance(prior, (int, float)):
                    moved = abs(price - float(prior)) * pip_factor
                    last_run = _parse_time(item.get("last_run_at"))
                    if anomaly_reason and (not last_run or (_now() - last_run).total_seconds() >= 300):
                        candidates.append((item["id"], anomaly_reason))
                        self._triggers.insert(0, self._new_trigger(kind="unplanned_anomaly", symbol=symbol, reason=anomaly_reason,
                            severity="high", source_timeframe=timeframe,
                            source_bar_time=str((bars[-1] if bars and isinstance(bars[-1], dict) else {}).get("time") or ""), topic_id=item["id"]))
                    elif moved >= float(item.get("volatility_pips", 45)) and (not last_run or (_now() - last_run).total_seconds() >= 300):
                        reason = f"volatility:{moved:.1f}pips"
                        candidates.append((item["id"], reason))
                        self._triggers.insert(0, self._new_trigger(kind="unplanned_anomaly", symbol=symbol, reason=reason,
                            severity="high", source_timeframe=timeframe,
                            source_bar_time=str((bars[-1] if bars and isinstance(bars[-1], dict) else {}).get("time") or ""), topic_id=item["id"]))
                    elif abnormal_range and (not last_run or (_now() - last_run).total_seconds() >= 300):
                        candidates.append((item["id"], "anomaly:range-expansion"))
                        self._triggers.insert(0, self._new_trigger(kind="unplanned_anomaly", symbol=symbol, reason="anomaly:range-expansion",
                            severity="high", source_timeframe=timeframe,
                            source_bar_time=str((bars[-1] if bars and isinstance(bars[-1], dict) else {}).get("time") or ""), topic_id=item["id"]))
            self._triggers = self._triggers[:MAX_TRIGGERS]
            self._save()
        for topic_id, trigger in candidates:
            if not topic_id:
                continue
            async def urgent(topic=topic_id, reason=trigger, latest_packet=packet):
                report = await self.run_topic(topic, reason)
                if reason.startswith("m5-confirmation:"):
                    trigger_id = reason.split(":", 1)[1]
                    await self._update_trigger(trigger_id, "confirmed_m5", m5_confirmation_report_id=report.get("id"), normal_policy_suspended=False)
                else:
                    matching = next((item for item in self._triggers if item.get("topic_id") == topic and item.get("reason") == reason and item.get("status") == "detected"), None)
                    if matching:
                        await self._update_trigger(matching["id"], "awaiting_m5", report_id=report.get("id"),
                                                   news_explanation_found=bool(report.get("sources")))
                if self._urgent_callback and report.get("status") == "evidence_ready":
                    self._urgent_callback(copy.deepcopy(latest_packet))
            asyncio.create_task(urgent())

    async def _run_due(self) -> None:
        now = _now()
        async with self._lock:
            candidates = []
            for item in self._topics:
                if not item.get("enabled"):
                    continue
                last = _parse_time(item.get("last_run_at"))
                if not last or (now - last).total_seconds() >= int(item.get("interval_minutes", 60)) * 60:
                    candidates.append((item["id"], "schedule"))
                for event in item.get("events", []):
                    at = _parse_time(event.get("at")) if isinstance(event, dict) else None
                    before = int(event.get("before_minutes", 0) or 0) if isinstance(event, dict) else 0
                    after = int(event.get("after_minutes", 0) or 0) if isinstance(event, dict) else 0
                    name = _safe_text(event.get("name"), 50) if isinstance(event, dict) else "event"
                    if at and (abs((now - (at - timedelta(minutes=before))).total_seconds()) <= 60 or abs((now - (at + timedelta(minutes=after))).total_seconds()) <= 60):
                        reason = f"event:{name}"
                        existing = next((row for row in self._triggers if row.get("topic_id") == item["id"] and row.get("reason") == reason and row.get("status") not in ("confirmed_m5", "closed")), None)
                        if not existing:
                            candidates.insert(0, (item["id"], reason))
                            self._triggers.insert(0, self._new_trigger(kind="planned_event", symbol=item["symbol"], reason=reason,
                                severity=str(event.get("impact") or "high"), source_timeframe="calendar",
                                source_bar_time=None, topic_id=item["id"], event=event))
            self._triggers = self._triggers[:MAX_TRIGGERS]
            self._save()
        for topic_id, trigger in candidates[:2]:
            if topic_id not in self._running_topics:
                try:
                    report = await self.run_topic(topic_id, trigger)
                    if trigger.startswith("event:"):
                        async with self._lock:
                            matching = next((row for row in self._triggers if row.get("topic_id") == topic_id
                                             and row.get("reason") == trigger and row.get("status") == "detected"), None)
                        if matching:
                            await self._update_trigger(matching["id"], "awaiting_m5", report_id=report.get("id"),
                                                       news_explanation_found=bool(report.get("sources")))
                except Exception as exc:
                    log.warning("专题自动任务失败 topic=%s: %s", topic_id, exc)

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        await asyncio.sleep(20)
        while True:
            try:
                await self._run_due()
            except Exception as exc:
                log.warning("专题研究调度异常: %s", exc)
            await asyncio.sleep(60)

    async def status(self) -> dict:
        async with self._lock:
            active = [item for item in self._topics if item.get("enabled")]
            valid = [item for item in self._reports if self._usable_report(item)]
            return {
                "topics": len(self._topics), "configured_topics": len(self._topics), "enabled_topics": len(active),
                "reports": len(self._reports), "valid_reports": len(valid), "running": len(self._running_topics), "storage": str(DATA_DIR),
            }


service = ResearchService()
