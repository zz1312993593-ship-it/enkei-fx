"""圆衡回测研究入口 —— 复用 Vibe-Trading 回测引擎（仅引擎层），本地离线运行。

作用：
- 把圆衡历史数据仓（decision-service/data/warehouse）灌入 Vibe-Trading 回测引擎
- 用 research/strategies.py 的策略生成目标权重信号
- 在外汇引擎（点差/杠杆/隔夜）规则下逐 K 执行
- 产出：指标 JSON、权益/回撤图、Markdown + HTML 报告，落在 research/output/{run_id}/

用法：
    python research/run_backtest.py --code USDJPY:H1 --strategy ema-cross \
        --start 2026-05-01 --end 2026-09-03 --initial-cash 200000 --leverage 50

说明：
- 引擎来自外部依赖 Vibe-Trading（MIT，仅作引擎层调用，运行时通过 sys.path 注入，
  不改动上游一行代码）；执行层护城河（8791 网关 + EA）零改动，本模块只研究不回放。
- 图表用本机中文字体（微软雅黑），找不到时回退默认字体。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # 无 GUI 后端，只落 PNG
import matplotlib.pyplot as plt
import pandas as pd

# ── 注入 Vibe-Trading 引擎层路径（外部依赖只读） ──────────────────────
_ENKEI_ROOT = Path(__file__).resolve().parent.parent      # decision-service/
_PROJECT = _ENKEI_ROOT.parent                              # 项目/
_ENKEI_REPO = _PROJECT.parent                              # 圆衡Enkei/（外部依赖在仓库根下）
_VIBE_AGENT = _ENKEI_REPO / "外部依赖" / "Vibe-Trading" / "agent"


def _ensure_vibe_path() -> None:
    if not _VIBE_AGENT.exists():
        raise FileNotFoundError(
            f"未找到 Vibe-Trading 引擎层: {_VIBE_AGENT}\n"
            "请先克隆 https://github.com/HKUDS/Vibe-Trading 到 外部依赖/ 目录。"
        )
    p = str(_VIBE_AGENT)
    if p not in sys.path:
        sys.path.insert(0, p)


# 中文标点输入支持
plt.rcParams["axes.unicode_minus"] = False


def _set_chinese_font() -> bool:
    """设置中文字体。返回是否找到中文字体（找不到则不含中文标注）。"""
    from matplotlib import font_manager

    candidates = ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC"]
    installed = {f.name for f in font_manager.fontManager.ttflist}
    for name in candidates:
        if name in installed:
            plt.rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
            return True
    return False


def _draw_charts(run_dir: Path, equity_csv: Path) -> dict[str, str]:
    """绘制权益曲线 + 回撤图，返回图表文件相对路径。"""
    eq = pd.read_csv(equity_csv, parse_dates=["timestamp"], index_col="timestamp")
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 8), sharex=True,
                                   gridspec_kw={"height_ratios": [3, 1]})
    ax1.plot(eq.index, eq["equity"], label="Strategy Equity", lw=1.2)
    if "benchmark_equity" in eq.columns and eq["benchmark_equity"].notna().any():
        ax1.plot(eq.index, eq["benchmark_equity"], label="Buy&Hold Avg", lw=1.0, alpha=0.7)
    ax1.set_ylabel("Equity (USD)")
    ax1.set_title("Backtest Equity Curve")
    ax1.grid(alpha=0.3)
    ax1.legend(loc="upper left")
    ax2.fill_between(eq.index, eq["drawdown"] * 100, 0, color="coral", alpha=0.6)
    ax2.set_ylabel("Drawdown %")
    ax2.grid(alpha=0.3)
    fig.tight_layout()
    equity_png = run_dir / "equity_curve.png"
    fig.savefig(equity_png, dpi=150)
    plt.close(fig)

    # 月度收益热力表（Markdown 表格用）
    monthly = (1 + eq["ret"]).resample("ME").prod() - 1
    monthly_path = run_dir / "monthly_returns.csv"
    monthly.rename("monthly_return").to_csv(monthly_path, float_format="%.4f")

    return {
        "equity_curve.png": equity_png.name,
        "monthly_returns.csv": monthly_path.name,
    }


def _fmt_metric(key: str, value) -> str:
    """指标展示格式化。"""
    if value is None:
        return "-"
    if isinstance(value, float):
        if key in ("total_return", "annual_return", "cagr") or "return" in key or key.endswith("_ret"):
            return f"{value * 100:.2f}%"
        if "drawdown" in key or key.endswith("_dd"):
            return f"{value * 100:.2f}%"
        return f"{value:.4f}"
    return str(value)


_PREFERRED_KEYS = [
    "total_return", "annual_return", "annual_volatility", "sharpe_ratio",
    "max_drawdown", "calmar_ratio", "sortino_ratio", "win_rate", "profit_factor",
    "num_trades", "total_fees", "final_equity", "turnover", "holding_days_mean",
]


def _render_markdown(run_dir: Path, metrics: dict, meta: dict, charts: dict[str, str]) -> str:
    lines = [
        "# 圆衡回测研究报告",
        "",
        "## 运行参数",
        "",
        "| 项 | 值 |",
        "|---|---|",
    ]
    for k, v in meta.items():
        lines.append(f"| {k} | {v} |")
    lines += ["", "## 绩效指标", ""]
    seen = set()
    for key in _PREFERRED_KEYS:
        if key in metrics:
            lines.append(f"- **{key}**: {_fmt_metric(key, metrics[key])}")
            seen.add(key)
    others = {k: v for k, v in metrics.items()
              if k not in seen and isinstance(v, (int, float, str)) and v is not None}
    if others:
        lines += ["", "### 明细", ""]
        for k in sorted(others):
            lines.append(f"- {k}: {_fmt_metric(k, others[k])}")
    lines += ["", "## 图表", ""]
    for name in charts:
        lines.append(f"![{name}]({name})")
    monthly = run_dir / "monthly_returns.csv"
    if monthly.exists():
        lines += ["", "## 月度收益", ""]
        mdf = pd.read_csv(monthly)
        lines.append(mdf.to_markdown(index=False))
    lines += ["", "---", "*由圆衡回测研究模块生成，基于 Vibe-Trading 引擎层（MIT）。*", ""]
    return "\n".join(lines)


def run_backtest(
    code: str,
    strategy_name: str,
    start_date: str,
    end_date: str,
    *,
    initial_cash: float = 200_000,
    leverage: float = 50,
    interval: str | None = None,
    strategy_kwargs: dict | None = None,
    out_root: Path | None = None,
) -> Path:
    """执行一次回测并产出全部报告，返回 run_dir。"""
    _ensure_vibe_path()

    from backtest.engines.forex import ForexEngine

    from enkei_loader import EnkeiLocalLoader
    from strategies import BaseStrategy, build_strategy

    tf = code.split(":", 1)[1] if ":" in code else (interval or "1H")
    run_id = f"{pd.Timestamp.now():%Y%m%d-%H%M%S}-{code.replace(':', '_')}-{strategy_name}"
    run_dir = (out_root or Path(__file__).resolve().parent / "output") / run_id
    (run_dir / "artifacts").mkdir(parents=True, exist_ok=True)

    config = {
        "codes": [code],
        "start_date": start_date,
        "end_date": end_date,
        "interval": tf,
        "source": "enkei-local",
        "engine": "forex",
        "position_adjustment": "rebalance",
        "initial_cash": initial_cash,
        "warmup_bars": 120,           # 预留指标预热，不计入绩效
        "leverage": leverage,
        "lot_size": 100_000,
    }

    loader = EnkeiLocalLoader()
    strategy: BaseStrategy = build_strategy(strategy_name, **(strategy_kwargs or {}))
    engine = ForexEngine(config)
    metrics = engine.run_backtest(
        config,
        loader,
        strategy,
        run_dir,
        bars_per_year=None,           # 日历日年化，适配外汇 5 日/周
    )
    metrics = json.loads(json.dumps(metrics, default=str))  # 转 JSON 可序列化

    # 报告
    _set_chinese_font()
    charts = _draw_charts(run_dir, run_dir / "artifacts" / "equity.csv")
    meta = {
        "code": code,
        "strategy": strategy.name,
        "period": f"{start_date} ~ {end_date}",
        "timeframe": tf,
        "initial_cash": initial_cash,
        "leverage": f"{leverage}:1",
        "engine": "Vibe-Trading ForexEngine (MIT)",
    }
    (run_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (run_dir / "report.md").write_text(
        _render_markdown(run_dir, metrics, meta, charts), encoding="utf-8"
    )
    _render_html(run_dir, metrics, meta, charts)

    # 收敛 symbol 指向最新
    latest = run_dir.parent / "latest"
    if latest.exists() or latest.is_symlink():
        latest.unlink()
    try:
        latest.symlink_to(run_dir.name, target_is_directory=True)
    except OSError:
        (run_dir.parent / "latest.txt").write_text(run_dir.name, encoding="utf-8")

    return run_dir


def _render_html(run_dir: Path, metrics: dict, meta: dict, charts: dict[str, str]) -> None:
    rows = "".join(
        f"<tr><td>{k}</td><td>{_fmt_metric(k, metrics[k])}</td></tr>"
        for k in _PREFERRED_KEYS if k in metrics
    )
    meta_rows = "".join(f"<tr><td>{k}</td><td>{v}</td></tr>" for k, v in meta.items())
    imgs = "".join(f'<img src="{name}" style="max-width:100%"/>' for name in charts
                   if name.endswith(".png"))
    html = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>圆衡回测报告</title>
<style>body{{font-family:'Microsoft YaHei',sans-serif;margin:2rem auto;max-width:960px}}
table{{border-collapse:collapse;width:100%;margin:.5rem 0}}
td,th{{border:1px solid #ddd;padding:.35rem .6rem;text-align:left}}
th{{background:#f5f5f5}}h1,h2{{color:#17324d}}</style></head>
<body><h1>圆衡回测研究报告</h1>
<h2>运行参数</h2><table>{meta_rows}</table>
<h2>绩效指标</h2><table>{rows}</table>
<h2>图表</h2>{imgs}
<hr><p><small>由圆衡回测研究模块生成 · 基于 Vibe-Trading 引擎层(MIT)</small></p>
</body></html>"""
    (run_dir / "report.html").write_text(html, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="圆衡回测研究 CLI")
    ap.add_argument("--code", required=True, help="品种:周期，如 USDJPY:H1")
    ap.add_argument("--strategy", default="ema-cross", help="策略名: ema-cross/channel-breakout/momentum")
    ap.add_argument("--start", required=True, help="起始日期 YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="结束日期 YYYY-MM-DD")
    ap.add_argument("--initial-cash", type=float, default=200_000)
    ap.add_argument("--leverage", type=float, default=50)
    ap.add_argument("--param", action="append", default=[], help="策略参数 key=value（可多传）")
    args = ap.parse_args()

    kwargs: dict = {}
    for item in args.param:
        k, _, v = item.partition("=")
        try:
            kwargs[k.strip()] = int(v)
        except ValueError:
            try:
                kwargs[k.strip()] = float(v)
            except ValueError:
                kwargs[k.strip()] = v.strip()

    run_dir = run_backtest(
        args.code, args.strategy, args.start, args.end,
        initial_cash=args.initial_cash,
        leverage=args.leverage,
        strategy_kwargs=kwargs,
    )
    print(json.dumps({"run_dir": str(run_dir), "ok": True}, ensure_ascii=False))
    print(f"\n报告: {run_dir / 'report.html'}")
    print(f"Markdown: {run_dir / 'report.md'}")


if __name__ == "__main__":
    main()
