"use client";

import { useCallback, useEffect, useState } from "react";

type Language = "zh" | "ja" | "en";
type Bucket = {
  name: string;
  samples: number;
  direction_accuracy: number;
  net_pnl: number;
  avg_pnl: number;
  strong_regime?: string | null;
  weak_regime?: string | null;
};
type Trace = {
  schema?: string;
  analysis_id?: string;
  request_id: string;
  created_at: string;
  finished_at?: string;
  status: string;
  transport?: string;
  route?: string;
  requested_provider?: string | null;
  requested_model_id?: string | null;
  actual_provider?: string | null;
  actual_model_id?: string | null;
  effective_model_id?: string | null;
  request_started_at?: string;
  model_response_started_at?: string | null;
  request_finished_at?: string | null;
  latency_ms?: number | null;
  first_response_ms?: number | null;
  retry_count?: number;
  degraded?: boolean;
  degrade_reason?: string | null;
  local_fallback_used?: boolean;
  submitted_to_model?: boolean;
  system_prompt_version?: string;
  analysis_protocol_version?: string;
  attempts?: Array<Record<string, unknown>>;
  agent_id?: string | null;
  market_packet?: Record<string, unknown>;
  context?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
};
type Dashboard = {
  generated_at: string;
  overview: {
    decisions: number;
    adopted: number;
    outcomes: number;
    direction_accuracy: number | null;
    net_pnl: number;
    avg_pnl: number | null;
    max_drawdown: number;
    sample_sufficient: boolean;
  };
  timeline: Array<Record<string, unknown>>;
  completed: Array<Record<string, unknown>>;
  cases: Record<string, number>;
  models: Bucket[];
  strategies: Bucket[];
  regimes: Bucket[];
  control: {
    settings: {
      mode: string;
      paused: boolean;
      minimum_samples: number;
      minimum_strategy_samples: number;
      minimum_condition_samples?: number;
      max_single_delta?: number;
      max_total_delta?: number;
      allow_confidence_adjustment: boolean;
      allow_weight_adjustment: boolean;
      allow_model_routing: boolean;
    };
    active: {
      version: number;
      weights: Record<string, number>;
      reason: string;
      status?: string;
      conditional_weights?: Record<string, Record<string, number>>;
      candidate_evaluation?: {
        new_outcomes: number;
        elapsed_days: number;
        required_outcomes: number;
        required_days: number;
        ready_for_activation: boolean;
        automatic_pause_reason?: string | null;
      };
    };
    proposal?: {
      id: string;
      status: string;
      samples: number;
      required_samples: number;
      weights: Record<string, number>;
      reason: string;
      ai_review?: {
        status: string;
        request_id?: string;
        provider?: string;
        model_id?: string;
        route?: string;
        completed_at?: string;
        summary?: string;
        risks?: string[];
        error?: string;
      } | null;
      conditional_proposals?: Array<{
        condition_key: string;
        condition: Record<string, string>;
        samples: number;
        direction_accuracy: number;
        net_pnl: number;
        risk: Record<string, number | null>;
        changes: Record<string, { old: number; delta: number; new: number }>;
        why: string;
        expected_improvement: string;
        do_not_apply_when: string[];
        rollback_to_version: number;
        confidence?: number;
        sample_reliability?: string;
        ai_evidence_summary?: string;
      }>;
    } | null;
    versions: unknown[];
    audit: Array<Record<string, unknown>>;
  };
  storage: {
    database_bytes: number;
    hot_records: number;
    warm_records: number;
    archives: number;
    archive_bytes: number;
    raw_records: number;
    today_records: number;
    backups: number;
    last_backup_at?: string | null;
  };
};

const labels: Record<string, string> = {
  judgment_and_execution_correct: "判断正确、执行正确",
  judgment_correct_timing_bad: "判断正确、执行时机不佳",
  judgment_wrong_risk_controlled: "判断错误、风险受控",
  judgment_and_execution_wrong: "判断与执行均错误",
  insufficient_data_wait: "证据不足／观望",
  sudden_news_invalidated: "突发新闻使判断失效",
};

const translatedValues: Record<string, [string, string, string]> = {
  long: ["做多", "ロング", "long"],
  short: ["做空", "ショート", "short"],
  wait: ["观望", "待機", "wait"],
  close: ["平仓", "決済", "close"],
  trend: ["趋势行情", "トレンド相場", "trend"],
  range: ["震荡行情", "レンジ相場", "range"],
  volatile: ["高波动行情", "高変動相場", "volatile"],
  uncertain: ["不确定行情", "不確実相場", "uncertain"],
  unknown: ["未知", "不明", "unknown"],
  rule_conflict: ["与安全规则冲突", "安全ルールと競合", "rule conflict"],
  insufficient_evidence: ["证据不足", "根拠不足", "insufficient evidence"],
};

export default function AiLearningCenter({ language }: { language: Language }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [environmentFilter, setEnvironmentFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] = useState("all");
  const t = (zh: string, ja: string, en: string) =>
    language === "zh" ? zh : language === "ja" ? ja : en;
  const valueLabel = (value: unknown) => {
    const raw = String(value ?? "—");
    const translated = translatedValues[raw.toLowerCase()];
    return translated ? t(...translated) : raw;
  };
  const load = useCallback(async () => {
    try {
      const [dashboardResponse, traceResponse] = await Promise.all([
        fetch(`http://127.0.0.1:8710/v1/learning/dashboard?limit=50&environment=${environmentFilter}&lifecycle=${lifecycleFilter}`, {
          cache: "no-store",
        }),
        fetch("http://127.0.0.1:8710/v1/audit/analysis?limit=50", {
          cache: "no-store",
        }),
      ]);
      if (!dashboardResponse.ok)
        throw new Error(`HTTP ${dashboardResponse.status}`);
      setData(await dashboardResponse.json());
      if (traceResponse.ok) {
        const body = (await traceResponse.json()) as { traces?: Trace[] };
        setTraces(body.traces ?? []);
      }
      setError("");
    } catch (e) {
      const prefix =
        language === "zh"
          ? "学习中心暂不可用"
          : language === "ja"
            ? "学習センターは利用できません"
            : "Learning centre unavailable";
      setError(`${prefix}: ${e instanceof Error ? e.message : ""}`);
    }
  }, [environmentFilter, language, lifecycleFilter]);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(load, 15000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);
  const act = async (
    name: string,
    url: string,
    body?: object,
    method = "POST",
  ) => {
    setBusy(name);
    try {
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        const x = (await r.json().catch(() => ({}))) as { detail?: unknown };
        throw new Error(String(x.detail ?? `HTTP ${r.status}`));
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const exportData = async () => {
    setBusy("export");
    try {
      const r = await fetch("http://127.0.0.1:8710/v1/learning/export", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `enkei-learning-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  if (!data)
    return (
      <section className="learning-center">
        <h2>{t("AI 学习中心", "AI学習センター", "AI learning centre")}</h2>
        <p>
          {error ||
            t(
              "正在读取永久学习档案…",
              "学習アーカイブを読込中…",
              "Loading persistent learning archive…",
            )}
        </p>
      </section>
    );
  const o = data.overview;
  const c = data.control;
  const traceLifecycle = (trace: Trace) => data.timeline.find(
    (item) => String(item.request_id ?? "") === trace.request_id,
  );
  return (
    <section className="learning-center">
      <div className="learning-head">
        <div>
          <p className="eyebrow">
            {t(
              "可审计学习闭环",
              "監査可能な学習ループ",
              "AUDITABLE LEARNING LOOP",
            )}
          </p>
          <h2>{t("AI 学习中心", "AI学習センター", "AI learning centre")}</h2>
          <p>
            {t(
              "行情 → AI 判断 → 本地策略 → 执行结果 → 复盘 → 下一次策略选择。记录永久保存，未经确认绝不改变策略。",
              "市場→AI判断→ローカル戦略→結果→検証→次の選択。確認なしで戦略を変更しません。",
              "Market → AI → local strategy → outcome → review → next selection. No strategy change without confirmation.",
            )}
          </p>
        </div>
        <span
          className={
            c.settings.paused ? "learning-badge warn" : "learning-badge"
          }
        >
          {c.settings.paused
            ? t("学习已暂停", "学習停止中", "paused")
            : c.settings.mode === "cautious"
              ? t(
                  `谨慎应用 · v${c.active.version}`,
                  `慎重適用 · v${c.active.version}`,
                  `cautious · v${c.active.version}`,
                )
              : t("仅记录", "記録のみ", "record only")}
        </span>
      </div>
      {error && <p className="learning-error">{error}</p>}
      <div className="learning-filters">
        <label>
          <span>{t("运行来源", "実行元", "Environment")}</span>
          <select value={environmentFilter} onChange={(event) => setEnvironmentFilter(event.target.value)}>
            <option value="all">{t("全部", "すべて", "All")}</option>
            <option value="demo">Demo</option>
            <option value="live">{t("实盘", "実取引", "Live")}</option>
            <option value="unknown">{t("未标记", "未分類", "Unlabelled")}</option>
          </select>
        </label>
        <label>
          <span>{t("结果状态", "結果状態", "Lifecycle")}</span>
          <select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value)}>
            <option value="all">{t("全部", "すべて", "All")}</option>
            <option value="completed">{t("已执行并复盘", "実行・検証済み", "Executed and reviewed")}</option>
            <option value="awaiting_outcome">{t("等待结果", "結果待ち", "Awaiting outcome")}</option>
            <option value="rejected">{t("安全规则拒绝", "安全規則で拒否", "Rejected by safety rules")}</option>
          </select>
        </label>
      </div>
      <h3 className="learning-section-title">
        {t("1. 学习概览", "1. 学習概要", "1. Learning overview")}
      </h3>
      <div className="learning-kpis">
        {[
          [t("AI 判断", "AI判断", "AI decisions"), o.decisions],
          [t("已采用", "採用", "Adopted"), o.adopted],
          [t("闭环结果", "完了結果", "Outcomes"), o.outcomes],
          [
            t("方向正确率", "方向精度", "Direction accuracy"),
            o.direction_accuracy == null
              ? "—"
              : `${Math.round(o.direction_accuracy * 100)}%`,
          ],
          [
            t(
              "平均盈亏／最大回撤",
              "平均損益／最大DD",
              "Avg P/L / max drawdown",
            ),
            `${o.avg_pnl?.toFixed(2) ?? "—"} / ${o.max_drawdown.toFixed(2)}`,
          ],
          [
            t("样本门槛", "サンプル閾値", "Sample gate"),
            o.sample_sufficient
              ? t("已达到", "達成", "met")
              : `${o.outcomes}/${c.settings.minimum_samples}`,
          ],
        ].map(([k, v]) => (
          <article key={String(k)}>
            <span>{k}</span>
            <strong>{v}</strong>
          </article>
        ))}
      </div>

      <div className="learning-grid">
        <article className="learning-card">
          <h3>{t("2. 判断时间线", "2. 判断タイムライン", "2. Decision timeline")}</h3>
          <p>
            {t(
              "每次判断都显示；未成交、被拒绝和等待结果也不会消失。",
              "全判断を表示し、未約定・拒否・結果待ちも残します。",
              "Every judgement remains visible, including rejected, unfilled and pending outcomes.",
            )}
          </p>
          <div className="learning-scroll">
            {data.timeline.length ? (
              data.timeline.map((x, i) => (
                <details
                  className="learning-row"
                  key={String(x.policy_id ?? i)}
                >
                  <summary>
                    <b>
                      {String(x.symbol ?? "—")} · {String(x.timeframe ?? "—")}
                    </b>
                    <span className={`learning-life ${String(x.lifecycle)}`}>
                      {String(x.lifecycle) === "completed"
                        ? t("已闭环", "完了", "completed")
                        : String(x.lifecycle) === "rejected"
                          ? t("未采用", "不採用", "rejected")
                          : t("等待结果", "結果待ち", "awaiting outcome")}
                    </span>
                  </summary>
                  <span>
                    {t("模型", "モデル", "Model")}：
                    {String(x.ai_provider ?? "—")} / {String(x.ai_model ?? "—")}{" "}
                    / {String(x.ai_model_version ?? "—")}
                  </span>
                  <span>
                    {t("AI 原始判断", "AI原判断", "AI judgement")}：
                    {valueLabel(x.ai_direction ?? x.final_action)} ·{" "}
                    {t("置信度", "確信度", "confidence")}{" "}
                    {String(x.ai_confidence ?? "—")} ·{" "}
                    {t("市场状态", "市場状態", "regime")}{" "}
                    {valueLabel(x.market_regime)}
                  </span>
                  <span>
                    {t("系统决定", "システム判断", "System decision")}：
                    {x.adopted
                      ? t("采用", "採用", "adopted")
                      : t("拒绝", "拒否", "rejected")}{" "}
                    · {valueLabel(x.reject_reason)} ·{" "}
                    {t("本地策略", "ローカル戦略", "local strategy")}{" "}
                    {String(x.strategy_model ?? "—")} v
                    {String(x.strategy_version ?? "—")}
                  </span>
                  <span>
                    {t("判断理由", "判断理由", "Rationale")}：
                    {String(x.rationale ?? "—")}
                  </span>
                  <span>
                    {t("失效条件", "無効条件", "Invalidation")}：
                    {String(x.invalidation ?? "—")}
                  </span>
                  {String(x.lifecycle) === "completed" && (
                    <small>
                      {t("最终结果", "最終結果", "Outcome")}：
                      {valueLabel(x.direction)} ·{" "}
                      {t("方向正确", "方向正解", "direction correct")}{" "}
                      {x.direction_correct ? "✓" : "×"} · P/L{" "}
                      {Number(x.closed_pnl ?? 0).toFixed(2)} ·{" "}
                      {t("持仓", "保有時間", "duration")}{" "}
                      {Math.round(Number(x.duration_seconds ?? 0) / 60)} min
                    </small>
                  )}
                </details>
              ))
            ) : (
              <small>
                {t(
                  "尚无判断记录。下一次 M5/M15 收盘后会在这里出现完整卡片。",
                  "判断記録はまだありません。次のM5/M15確定後に表示されます。",
                  "No judgement yet. A complete card appears after the next M5/M15 close.",
                )}
              </small>
            )}
          </div>
        </article>
        <article className="learning-card">
          <h3>
            {t(
              "3. 成功与错误案例库",
              "成功・失敗ケース",
              "Success and error cases",
            )}
          </h3>
          {Object.entries(labels).map(([key, label]) => (
            <div className="learning-stat" key={key}>
              <span>
                {language === "zh" ? label : key.replaceAll("_", " ")}
              </span>
              <b>{data.cases[key] ?? 0}</b>
            </div>
          ))}
        </article>
      </div>

      <div className="learning-grid three">
        {[
          [t("4. 模型能力对比", "4. モデル比較", "4. Model comparison"), data.models],
          [t("策略表现", "戦略実績", "Strategy performance"), data.strategies],
          [t("市场状态表现", "相場状態別", "Regime performance"), data.regimes],
        ].map(([title, rows]) => (
          <article className="learning-card" key={String(title)}>
            <h3>{String(title)}</h3>
            {(rows as Bucket[]).length ? (
              (rows as Bucket[]).map((x) => (
                <div className="learning-stat" key={x.name}>
                  <span>
                    {x.name}
                    <small>
                      {x.samples} {t("样本", "件", "samples")} ·{" "}
                      {t("方向正确率", "方向精度", "accuracy")}{" "}
                      {Math.round(x.direction_accuracy * 100)}%
                      {x.strong_regime
                        ? ` · ${t("擅长", "得意", "strong")} ${valueLabel(x.strong_regime)}`
                        : ""}
                      {x.weak_regime
                        ? ` · ${t("薄弱", "弱点", "weak")} ${valueLabel(x.weak_regime)}`
                        : ""}
                    </small>
                  </span>
                  <b>{x.net_pnl.toFixed(2)}</b>
                </div>
              ))
            ) : (
              <small>
                {t(
                  "证据不足，暂不排名。",
                  "根拠不足のため順位なし。",
                  "Insufficient evidence; no ranking.",
                )}
              </small>
            )}
          </article>
        ))}
      </div>

      <article className="learning-card learning-conversation">
        <h3>
          {t(
            "本地统一分析会话（可见记录）",
            "ローカル統合分析会話",
            "Local unified-analysis conversation",
          )}
        </h3>
        <p>
          {t(
            "直接展示系统送入模型的市场材料、研究上下文、模型结果与错误。这里是圆衡自己的永久记录，不依赖 LibreChat 网页聊天历史。",
            "モデルへ送った市場資料・研究文脈・結果・エラーを直接表示します。LibreChatの通常履歴には依存しません。",
            "Shows the market packet, research context, model result and errors locally. This permanent record does not depend on LibreChat chat history.",
          )}
        </p>
        <div className="learning-scroll">
          {traces.length ? (
            traces.map((trace) => (
              <details className="conversation-turn" key={trace.request_id}>
                <summary>
                  <span>
                    <b>
                      {String(trace.market_packet?.symbol ?? "—")} ·{" "}
                      {String(trace.market_packet?.timeframe ?? "—")}
                    </b>
                    <small>
                      {new Date(trace.created_at).toLocaleString()} ·{" "}
                      {trace.request_id}
                    </small>
                  </span>
                  <em className={`trace-${trace.status}`}>
                    {trace.status === "succeeded"
                      ? t("分析完成", "分析完了", "completed")
                      : trace.status === "submitted"
                        ? t("分析中", "分析中", "running")
                        : trace.status === "rejected"
                          ? t("已拒绝", "拒否", "rejected")
                          : t("失败", "失敗", "failed")}
                  </em>
                </summary>
                <div className="trace-identity">
                  <b>{t("真实调用信息", "実呼出し情報", "Verified call information")}</b>
                  <span>{trace.submitted_to_model === false
                    ? t("数据安全门拒绝，未调用模型", "データ検証で拒否、モデル未呼出し", "Rejected by data gate; model not called")
                    : <>{t("实际供应商", "実プロバイダー", "Actual provider")}：{String(trace.actual_provider ?? "—")} / {String(trace.actual_model_id ?? "—")}</>}
                  </span>
                  <span>
                    {t("计划调用", "予定呼出し", "Requested route")}：
                    {String(trace.requested_provider ?? "—")} / {String(trace.requested_model_id ?? "—")}
                  </span>
                  <span>
                    {t("路由", "経路", "Route")}：{String(trace.route ?? trace.transport ?? "—")} · {t("耗时", "所要時間", "Latency")} {trace.latency_ms == null ? "—" : `${(trace.latency_ms / 1000).toFixed(2)}s`} · {t("重试", "再試行", "Retries")} {trace.retry_count ?? 0}
                  </span>
                  <span>
                    {trace.degraded ? t("已发生降级", "フォールバック済み", "Degraded") : t("未降级", "フォールバックなし", "Not degraded")} · {trace.local_fallback_used ? t("使用了本地备用模型", "ローカル代替モデル使用", "Local fallback used") : t("未使用本地备用模型", "ローカル代替なし", "No local fallback")}
                  </span>
                  <small>
                    {trace.request_started_at ? new Date(trace.request_started_at).toLocaleString() : "—"} → {trace.request_finished_at ? new Date(trace.request_finished_at).toLocaleString() : t("处理中", "処理中", "running")} · {String(trace.system_prompt_version ?? "—")} · {String(trace.analysis_protocol_version ?? "—")}
                  </small>
                </div>
                <div className="conversation-bubble user">
                  <b>
                    {trace.submitted_to_model === false
                      ? t("安全校验读取的材料（未发送给模型）", "安全検証で読み取った資料（モデル未送信）", "Material read by validation (not sent to model)")
                      : t("提交给模型的材料", "モデルへの入力", "Input sent to model")}
                  </b>
                  <pre>
                    {JSON.stringify(
                      { market: trace.market_packet, context: trace.context },
                      null,
                      2,
                    )}
                  </pre>
                </div>
                <div className="conversation-bubble assistant">
                  <b>{trace.submitted_to_model === false
                    ? t("校验结果", "検証結果", "Validation result")
                    : t("统一分析体回复", "統合分析体の応答", "Unified analyst response")}</b>
                  {trace.result ? (
                    <pre>{JSON.stringify(trace.result, null, 2)}</pre>
                  ) : (
                    <p>
                      {trace.error === "bars: history is stale"
                        ? t("历史K线已过期，系统为避免使用旧行情而拒绝调用模型。", "履歴K線が期限切れのため、古い相場でモデルを呼び出さないよう拒否しました。", "Historical bars are stale; the model call was blocked to avoid using old market data.")
                        : trace.error ||
                        t(
                          "等待模型返回结果。",
                          "モデル応答待ち。",
                          "Waiting for the model response.",
                        )}
                    </p>
                  )}
                </div>
                {traceLifecycle(trace) ? (
                  <>
                    <div className="conversation-bubble system">
                      <b>{t("系统安全复核", "システム安全確認", "System safety review")}</b>
                      <p>
                        {traceLifecycle(trace)?.adopted
                          ? t("已采用 AI 判断", "AI判断を採用", "AI judgement adopted")
                          : t("未采用 AI 判断", "AI判断を不採用", "AI judgement rejected")}
                        {" · "}{t("最终决定", "最終判断", "Final decision")}：{valueLabel(traceLifecycle(trace)?.final_action)}
                        {" · "}{t("本地策略", "ローカル戦略", "Local strategy")}：{String(traceLifecycle(trace)?.strategy_model ?? "—")} v{String(traceLifecycle(trace)?.strategy_version ?? "—")}
                      </p>
                      <small>{t("安全门", "安全ゲート", "Safety gate")}：{JSON.stringify(traceLifecycle(trace)?.gate_summary ?? {})} · {t("拒绝原因", "拒否理由", "Rejection reason")}：{valueLabel(traceLifecycle(trace)?.reject_reason)}</small>
                    </div>
                    <div className="conversation-bubble execution">
                      <b>{t("执行与仓位结果", "執行・ポジション結果", "Execution and position result")}</b>
                      {String(traceLifecycle(trace)?.lifecycle) === "completed" ? (
                        <p>
                          {t("已成交并完成", "約定・完了", "Filled and completed")} · {valueLabel(traceLifecycle(trace)?.direction)} · {t("入场", "建値", "entry")} {String(traceLifecycle(trace)?.entry_price ?? "—")} → {t("退出", "決済", "exit")} {String(traceLifecycle(trace)?.exit_price ?? "—")} · P/L {Number(traceLifecycle(trace)?.closed_pnl ?? 0).toFixed(2)} · {t("持仓", "保有", "duration")} {Math.round(Number(traceLifecycle(trace)?.duration_seconds ?? 0) / 60)} min
                        </p>
                      ) : (
                        <p>{String(traceLifecycle(trace)?.lifecycle) === "rejected"
                          ? t("安全规则拒绝，未执行。", "安全ルールにより拒否され、未実行です。", "Rejected by safety rules; not executed.")
                          : t("已通过复核，等待成交或结果回传。", "確認済み。約定または結果受信待ちです。", "Review passed; awaiting fill or outcome feedback.")}</p>
                      )}
                    </div>
                    <div className="conversation-bubble review">
                      <b>{t("闭环复盘", "クローズドループ検証", "Closed-loop review")}</b>
                      {String(traceLifecycle(trace)?.lifecycle) === "completed" ? (
                        <p>{t("方向是否正确", "方向の正否", "Direction correct")}：{traceLifecycle(trace)?.direction_correct ? "✓" : "×"} · {t("案例分类", "ケース分類", "Case")}：{String(traceLifecycle(trace)?.case_type ?? "—")} · {t("本次结果已进入学习样本", "学習標本に記録済み", "Outcome entered into the learning sample")}</p>
                      ) : (
                        <p>{t("结果尚未闭环，不会提前评价，也不会据此调整权重。", "結果未確定のため早期評価や重み変更は行いません。", "The outcome is not closed; no premature review or weight adjustment is allowed.")}</p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="conversation-bubble system">
                    <b>{t("等待系统复核记录", "システム確認記録待ち", "Awaiting system review record")}</b>
                    <p>{t("模型调用已保存；系统决定、执行与复盘会在回执到达后实时追加。", "モデル呼出しは保存済みです。判断・執行・検証は受信後に追記されます。", "The model call is saved; system decision, execution and review append as receipts arrive.")}</p>
                  </div>
                )}
              </details>
            ))
          ) : (
            <small>
              {t(
                "尚无可展示的模型调用。下一次分析会自动写入这里。",
                "表示可能なモデル呼出しはまだありません。",
                "No model call to display yet; the next analysis is recorded automatically.",
              )}
            </small>
          )}
        </div>
      </article>

      <article className="learning-card control">
        <div>
          <h3>
            {t(
              "5. 策略学习控制",
              "5. 戦略学習コントロール",
              "5. Strategy learning control",
            )}
          </h3>
          <p>{c.active.reason}</p>
          {c.active.status === "candidate" && c.active.candidate_evaluation && (
            <small>
              {t("候选版本观察", "候補版の観察", "Candidate observation")}：
              {c.active.candidate_evaluation.new_outcomes}/{c.active.candidate_evaluation.required_outcomes} {t("个结果", "件", "outcomes")} · {c.active.candidate_evaluation.elapsed_days}/{c.active.candidate_evaluation.required_days} {t("天", "日", "days")}
            </small>
          )}
          {c.active.status === "candidate_paused" && <p className="learning-error">{t("候选版本因风险恶化已自动暂停，可以回滚上一版。", "リスク悪化により候補版を自動停止しました。前版へ戻せます。", "The candidate was automatically paused after risk deterioration and can be rolled back.")}</p>}
          <div className="learning-permissions">
            <label>
              <input
                type="checkbox"
                checked={c.settings.allow_confidence_adjustment}
                onChange={(e) =>
                  void act(
                    "settings",
                    "http://127.0.0.1:8710/v1/learning/settings",
                    { allow_confidence_adjustment: e.target.checked },
                    "PUT",
                  )
                }
              />
              {t(
                "允许建议调整置信度门槛",
                "確信度閾値の提案を許可",
                "Allow confidence-threshold proposals",
              )}
            </label>
            <label>
              <input
                type="checkbox"
                checked={c.settings.allow_weight_adjustment}
                onChange={(e) =>
                  void act(
                    "settings",
                    "http://127.0.0.1:8710/v1/learning/settings",
                    { allow_weight_adjustment: e.target.checked },
                    "PUT",
                  )
                }
              />
              {t(
                "允许建议调整策略权重",
                "戦略重みの提案を許可",
                "Allow strategy-weight proposals",
              )}
            </label>
            <label>
              <input
                type="checkbox"
                checked={c.settings.allow_model_routing}
                onChange={(e) =>
                  void act(
                    "settings",
                    "http://127.0.0.1:8710/v1/learning/settings",
                    { allow_model_routing: e.target.checked },
                    "PUT",
                  )
                }
              />
              {t(
                "允许建议调整模型路由",
                "モデル経路の提案を許可",
                "Allow model-routing proposals",
              )}
            </label>
          </div>
        </div>
        <div className="learning-actions">
          <button
            disabled={!!busy}
            onClick={() =>
              act(
                "pause",
                "http://127.0.0.1:8710/v1/learning/settings",
                { paused: !c.settings.paused },
                "PUT",
              )
            }
          >
            {c.settings.paused
              ? t("继续学习", "再開", "Resume")
              : t("暂停学习", "停止", "Pause")}
          </button>
          <button
            disabled={!!busy || !c.settings.allow_weight_adjustment}
            onClick={() =>
              act("proposal", "http://127.0.0.1:8710/v1/learning/proposals")
            }
          >
            {t("生成权重建议", "重み提案を生成", "Generate proposal")}
          </button>
          <button
            disabled={!!busy || !c.versions.length}
            onClick={() =>
              window.confirm(
                t(
                  "确认回滚到上一版权重？",
                  "前バージョンへ戻しますか？",
                  "Roll back to the previous weights?",
                ),
              ) &&
              act("rollback", "http://127.0.0.1:8710/v1/learning/rollback", {
                confirmation: "ROLLBACK",
              })
            }
          >
            {t("回滚上一版", "前版へ戻す", "Rollback")}
          </button>
          {c.active.status === "candidate" && (
            <button
              disabled={!!busy || !c.active.candidate_evaluation?.ready_for_activation}
              onClick={() => window.confirm(t("候选版本已经满足观察门槛，确认正式启用？", "候補版は観察条件を満たしました。正式に有効化しますか？", "The candidate passed its observation gate. Activate it?")) && act("activate", "http://127.0.0.1:8710/v1/learning/candidate/activate", { confirmation: "ACTIVATE" })}
            >
              {t("正式启用候选版本", "候補版を正式採用", "Activate candidate")}
            </button>
          )}
        </div>
      </article>
      {c.proposal && (
        <article className="learning-proposal">
          <div>
            <b>{t("待确认权重提案", "確認待ち重み提案", "Weight proposal")}</b>
            <p>{c.proposal.reason}</p>
            <small>
              {t(
                "未确认前不会影响任何策略选择。",
                "確認前は戦略選択に影響しません。",
                "It cannot affect selection before confirmation.",
              )}
            </small>
          </div>
          <div className="learning-ai-review">
            <b>{t("AI 权重审查", "AI重み審査", "AI weight review")}</b>
            {c.proposal.ai_review?.status === "completed" ? (
              <>
                <span>{String(c.proposal.ai_review.provider ?? "—")} / {String(c.proposal.ai_review.model_id ?? "—")} · {String(c.proposal.ai_review.route ?? "—")}</span>
                <small>{t("请求编号", "リクエストID", "Request ID")}：{c.proposal.ai_review.request_id ?? "—"}</small>
                <p>{c.proposal.ai_review.summary || t("AI审查已完成。", "AI審査完了。", "AI review completed.")}</p>
                {(c.proposal.ai_review.risks ?? []).map((risk, index) => <small key={index}>{t("风险", "リスク", "Risk")}：{risk}</small>)}
              </>
            ) : c.proposal.ai_review?.status === "failed" ? (
              <p className="negative">{t("AI审查失败，提案不能确认：", "AI審査失敗。提案は確認できません：", "AI review failed; the proposal cannot be confirmed: ")}{c.proposal.ai_review.error}</p>
            ) : (
              <p>{t("正在等待统一分析体审查；未经AI审查的统计草案不能应用。", "統合分析体の審査待ち。AI未審査の統計案は適用できません。", "Awaiting unified-analyst review; an unreviewed statistical draft cannot be applied.")}</p>
            )}
          </div>
          <div>
            {Object.entries(c.proposal.weights).map(([k, v]) => (
              <span key={k}>
                {k} × {Number(v).toFixed(3)}
              </span>
            ))}
          </div>
          {c.proposal.conditional_proposals?.map((item) => (
            <details className="learning-row" key={item.condition_key}>
              <summary>
                <b>{Object.values(item.condition).join(" · ")}</b>
                <span>{item.samples} {t("个闭环样本", "件の完了サンプル", "closed-loop samples")}</span>
              </summary>
              <span>{t("方向正确率", "方向精度", "Direction accuracy")}：{Math.round(item.direction_accuracy * 100)}% · P/L {item.net_pnl.toFixed(2)}</span>
              <span>{t("证据", "根拠", "Evidence")}：{item.why}</span>
              <span>{t("预期改善", "期待改善", "Expected improvement")}：{item.expected_improvement}</span>
              {item.ai_evidence_summary && <span>{t("AI证据摘要", "AI根拠要約", "AI evidence summary")}：{item.ai_evidence_summary}</span>}
              {item.sample_reliability && <small>{t("样本可信度", "標本信頼度", "Sample reliability")}：{item.sample_reliability} · {t("AI置信度", "AI確信度", "AI confidence")} {item.confidence ?? 0}%</small>}
              {Object.entries(item.changes).map(([strategy, change]) => (
                <small key={strategy}>{strategy}: {change.old.toFixed(3)} → {change.new.toFixed(3)} ({change.delta >= 0 ? "+" : ""}{change.delta.toFixed(3)})</small>
              ))}
              <small>{t("回滚目标版本", "ロールバック先", "Rollback target")}：v{item.rollback_to_version}</small>
            </details>
          ))}
          {c.proposal.status === "pending" && (
            <button
              disabled={!!busy}
              onClick={() =>
                window.confirm(
                  t(
                    "确认应用此版本？系统将保留旧版本并允许回滚。",
                    "この版を適用しますか？旧版は保存されます。",
                    "Apply this version? The previous version remains rollback-safe.",
                  ),
                ) &&
                act(
                  "confirm",
                  `http://127.0.0.1:8710/v1/learning/proposals/${c.proposal?.id}/confirm`,
                  { confirmation: "APPLY" },
                )
              }
            >
              {t("确认并应用", "確認して適用", "Confirm & apply")}
            </button>
          )}
        </article>
      )}

      <article className="learning-card storage">
        <div>
          <h3>{t("6. 数据存储管理", "6. データ保存管理", "6. Storage management")}</h3>
          <p>
            {t(
              "热数据随时读取，温数据按需检索，冷数据压缩归档且默认不载入。判断、执行、盈亏和复盘长期保留。",
              "ホットは常時、ウォームは検索、コールドは圧縮し通常非読込。判断・実行・損益・検証は長期保存。",
              "Hot data is immediate, warm data is retrieved on demand and cold data stays compressed. Decisions, execution, P/L and reviews are retained.",
            )}
          </p>
          <small>
            {t("上次备份", "最終バックアップ", "Last backup")}：
            {data.storage.last_backup_at
              ? new Date(data.storage.last_backup_at).toLocaleString()
              : t("尚未备份", "未実施", "never")}
          </small>
        </div>
        <div className="storage-metrics">
          <span>
            {t("数据库大小", "DBサイズ", "Database size")}
            <b>{(data.storage.database_bytes / 1024).toFixed(1)} KB</b>
          </span>
          <span>
            {t("今日新增", "本日追加", "Added today")}
            <b>{data.storage.today_records}</b>
          </span>
          <span>
            {t("原始记录", "原記録", "Raw records")}
            <b>{data.storage.raw_records}</b>
          </span>
          <span>
            {t("热／温／冷", "ホット／ウォーム／コールド", "Hot / warm / cold")}
            <b>
              {data.storage.hot_records} / {data.storage.warm_records} /{" "}
              {data.storage.archives}
            </b>
          </span>
          <span>
            {t("备份数量", "バックアップ数", "Backups")}
            <b>{data.storage.backups}</b>
          </span>
        </div>
        <div className="learning-actions">
          <button
            disabled={!!busy}
            onClick={() =>
              act("archive", "http://127.0.0.1:8710/v1/learning/archive")
            }
          >
            {t("立即备份并归档", "今すぐバックアップ", "Backup & archive")}
          </button>
          <button disabled={!!busy} onClick={() => void exportData()}>
            {t("导出数据", "データを書出す", "Export")}
          </button>
          <button
            disabled={!!busy || !data.storage.backups}
            onClick={() =>
              window.confirm(
                t(
                  "确认从最近备份恢复？当前台账会先生成安全副本。",
                  "最新バックアップから復元しますか？現在の台帳も退避します。",
                  "Restore the latest backup? A safety copy of the current ledger is created first.",
                ),
              ) &&
              act("restore", "http://127.0.0.1:8710/v1/learning/restore", {
                confirmation: "RESTORE",
              })
            }
          >
            {t("恢复最近备份", "最新バックアップを復元", "Restore latest")}
          </button>
          <button
            disabled={!!busy || data.storage.archives <= 5}
            onClick={() =>
              window.confirm(
                t(
                  "仅删除超过五份的旧冷归档，确认清理？",
                  "5件を超える古い冷却アーカイブのみ削除します。",
                  "Delete only cold archives older than the latest five?",
                ),
              ) &&
              act("cleanup", "http://127.0.0.1:8710/v1/learning/cleanup", {
                confirmation: "CLEANUP",
              })
            }
          >
            {t("清理旧归档", "古いアーカイブを整理", "Clean old archives")}
          </button>
        </div>
      </article>
    </section>
  );
}
