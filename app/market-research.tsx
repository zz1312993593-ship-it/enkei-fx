"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Language = "zh" | "ja" | "en";

type ResearchEvent = {
  name: string;
  at: string;
  before_minutes: number;
  after_minutes: number;
};

type ResearchTopic = {
  id: string;
  symbol: string;
  name: string;
  enabled: boolean;
  language: string;
  interval_minutes: number;
  volatility_pips: number;
  events: ResearchEvent[];
  last_run_at?: string;
  last_trigger?: string;
  preset?: boolean;
};

type ResearchReport = {
  id: string;
  topic_id: string;
  symbol: string;
  generated_at: string;
  valid_until: string;
  status: "evidence_ready" | "insufficient_sources";
  trigger: string;
  headline: string;
  thesis: {
    short_bias?: string;
    mid_bias?: string;
    confidence?: string | number;
    summary?: string;
    rationale?: string;
  };
  drivers: string[];
  key_levels: Array<
    string | { label?: string; value?: string | number; meaning?: string }
  >;
  risks: string[];
  next_checks: string[];
  sources: Array<{
    title?: string;
    link?: string;
    url?: string;
    published?: string;
    display?: string;
    source?: string;
  }>;
  source_assessment?: string;
  model?: string;
  data_status?: Record<string, unknown>;
  related_markets?: unknown[];
  event_assessment?: unknown[];
  evidence_balance?: { bull?: unknown[]; bear?: unknown[]; wait?: unknown[]; conflicts?: unknown[]; dominant?: string };
  logic_consistency?: Record<string, unknown>;
  scenarios?: Record<string, unknown>;
  final_judgment?: Record<string, unknown>;
  change_from_previous?: Record<string, unknown>;
  verified_facts?: unknown[];
  inferences?: unknown[];
  system_recommendations?: unknown[];
};

type ResearchStatus = {
  topics?: number;
  configured_topics: number;
  enabled_topics: number;
  valid_reports: number;
  running?: number;
  storage: string;
};

type ResearchContext = { context?: string; report_id?: string };

type ResearchTrigger = {
  id: string;
  kind: "planned_event" | "unplanned_anomaly";
  symbol: string;
  reason: string;
  severity: string;
  status: string;
  detected_at: string;
  source_timeframe: string;
  formal_decision_timeframe: string;
  normal_policy_suspended: boolean;
  news_explanation_found?: boolean;
  report_id?: string;
  m5_confirmation_report_id?: string;
};

type ApiPayload = Record<string, unknown>;

const API = "http://127.0.0.1:8710";

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asPayload(value: unknown): ApiPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ApiPayload)
    : {};
}

function localDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function readable(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}

export default function MarketResearchPanel({
  language,
  activeSymbol,
}: {
  language: Language;
  activeSymbol: string;
}) {
  const zh = language === "zh";
  const ja = language === "ja";
  const t = useCallback(
    (cn: string, jp: string, en: string) => (zh ? cn : ja ? jp : en),
    [ja, zh],
  );
  const reportValue = useCallback(
    (value?: string) => {
      const normalized = value?.trim().toLowerCase();
      const values: Record<string, [string, string, string]> = {
        long: ["偏多", "買い優勢", "Long bias"],
        short: ["偏空", "売り優勢", "Short bias"],
        wait: ["观望", "待機", "Wait"],
        close: ["建议退出", "退出を提案", "Suggest close"],
        schedule: ["定时任务", "定時実行", "Scheduled"],
        manual: ["手动生成", "手動実行", "Manual"],
        event: ["事件触发", "イベント起動", "Event-triggered"],
        volatility: ["波动触发", "変動起動", "Volatility-triggered"],
      };
      const translated = normalized ? values[normalized] : undefined;
      return translated ? t(...translated) : value || "—";
    },
    [t],
  );
  const topicName = useCallback(
    (topic: ResearchTopic) => {
      if (!topic.preset) return topic.name;
      const names: Record<string, [string, string, string]> = {
        USDJPY: [
          "美元／日元：央行、利差与风险情绪",
          "米ドル／円：中銀・金利差・リスク心理",
          "USD/JPY: central banks, rates and risk sentiment",
        ],
        EURUSD: [
          "欧元／美元：欧美政策差与美元周期",
          "ユーロ／ドル：欧米政策差とドル循環",
          "EUR/USD: policy divergence and dollar cycle",
        ],
        GBPUSD: [
          "英镑／美元：英国通胀与央行路径",
          "ポンド／ドル：英国インフレと中銀経路",
          "GBP/USD: UK inflation and central-bank path",
        ],
        EURJPY: [
          "欧元／日元：欧洲央行与日本央行政策差",
          "ユーロ／円：ECB・日銀政策差",
          "EUR/JPY: ECB/BOJ policy divergence",
        ],
        GBPJPY: [
          "英镑／日元：风险偏好与套利交易",
          "ポンド／円：リスク選好とキャリー取引",
          "GBP/JPY: risk appetite and carry trades",
        ],
      };
      return names[topic.symbol] ? t(...names[topic.symbol]) : topic.name;
    },
    [t],
  );
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [context, setContext] = useState<ResearchContext | null>(null);
  const [triggers, setTriggers] = useState<ResearchTrigger[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [symbol, setSymbol] = useState(activeSymbol.replace("/", ""));
  const [name, setName] = useState("");
  const [interval, setIntervalMinutes] = useState("15");
  const [volatility, setVolatility] = useState("35");
  const [eventName, setEventName] = useState("");
  const [eventAt, setEventAt] = useState("");

  const selected = useMemo(
    () => topics.find((item) => item.id === selectedId) ?? topics[0],
    [topics, selectedId],
  );

  const request = useCallback(
    async (path: string, init?: RequestInit): Promise<ApiPayload> => {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      const body = asPayload(await response.json().catch(() => ({})));
      if (!response.ok)
        throw new Error(
          asText(body.detail) || `${response.status} ${response.statusText}`,
        );
      return body;
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const [topicData, statusData] = await Promise.all([
        request("/v1/research/topics"),
        request("/v1/research/status"),
      ]);
      const nextTopics = Array.isArray(topicData.topics)
        ? (topicData.topics as ResearchTopic[])
        : [];
      setTopics(nextTopics);
      setStatus(statusData as ResearchStatus);
      const nextSelected =
        nextTopics.find((item) => item.id === selectedId) ?? nextTopics[0];
      if (nextSelected) {
        setSelectedId(nextSelected.id);
        const [reportData, contextData, triggerData] = await Promise.all([
          request(
            `/v1/research/reports?symbol=${encodeURIComponent(nextSelected.symbol)}&limit=8`,
          ),
          request(
            `/v1/research/context?symbol=${encodeURIComponent(nextSelected.symbol)}`,
          ),
          request(
            `/v1/research/triggers?symbol=${encodeURIComponent(nextSelected.symbol)}&limit=20`,
          ),
        ]);
        setReports(
          Array.isArray(reportData.reports)
            ? (reportData.reports as ResearchReport[])
            : [],
        );
        setContext(contextData as ResearchContext);
        setTriggers(
          Array.isArray(triggerData.triggers)
            ? (triggerData.triggers as ResearchTrigger[])
            : [],
        );
      } else {
        setReports([]);
        setContext(null);
        setTriggers([]);
      }
    } catch (error) {
      setNotice(
        `${t("无法连接 AI 终端：", "AI ターミナルに接続できません：", "Cannot reach AI terminal: ")}${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [request, selectedId, t]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  const selectTopic = async (topic: ResearchTopic) => {
    setSelectedId(topic.id);
    try {
      const [data, contextData, triggerData] = await Promise.all([
        request(
          `/v1/research/reports?symbol=${encodeURIComponent(topic.symbol)}&limit=8`,
        ),
        request(
          `/v1/research/context?symbol=${encodeURIComponent(topic.symbol)}`,
        ),
        request(
          `/v1/research/triggers?symbol=${encodeURIComponent(topic.symbol)}&limit=20`,
        ),
      ]);
      setReports(
        Array.isArray(data.reports) ? (data.reports as ResearchReport[]) : [],
      );
      setContext(contextData as ResearchContext);
      setTriggers(
        Array.isArray(triggerData.triggers)
          ? (triggerData.triggers as ResearchTrigger[])
          : [],
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const createTopic = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const events =
        eventName.trim() && eventAt
          ? [
              {
                name: eventName.trim(),
                at: new Date(eventAt).toISOString(),
                before_minutes: 30,
                after_minutes: 30,
              },
            ]
          : [];
      const data = await request("/v1/research/topics", {
        method: "POST",
        body: JSON.stringify({
          symbol,
          name:
            name.trim() ||
            `${symbol.toUpperCase()} ${t("专项追踪", "特別追跡", "Research")}`,
          language,
          interval_minutes: Number(interval),
          volatility_pips: Number(volatility),
          events,
          enabled: true,
        }),
      });
      setNotice(
        t(
          "专题已创建；首次报告需点击“立即研究”或等待调度。",
          "トピックを作成しました。最初のレポートは「今すぐ研究」またはスケジューラで生成されます。",
          "Topic created. Run it now or wait for the scheduler for its first report.",
        ),
      );
      setName("");
      setEventName("");
      setEventAt("");
      await load();
      const createdTopic = asPayload(data.topic);
      if (asText(createdTopic.id)) setSelectedId(asText(createdTopic.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateTopic = async (
    topic: ResearchTopic,
    patch: Partial<ResearchTopic>,
  ) => {
    setBusy(true);
    try {
      await request(`/v1/research/topics/${topic.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...topic, ...patch }),
      });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const runTopic = async (topic: ResearchTopic) => {
    setBusy(true);
    setNotice(
      t(
        "统一分析体正在生成报告…",
        "統一分析体がレポートを作成中です…",
        "The unified analyst is generating the report…",
      ),
    );
    try {
      const data = await request(`/v1/research/topics/${topic.id}/run`, {
        method: "POST",
        body: JSON.stringify({ trigger: "manual", language }),
      });
      if (data.status === "running") {
        setNotice(
          t(
            "该专题正在生成；完成后会自动刷新。",
            "このトピックは生成中です。完了後に自動更新します。",
            "This track is already running and will refresh when complete.",
          ),
        );
        await load();
        return;
      }
      const report = asPayload(data.report);
      setNotice(
        report.status === "evidence_ready"
          ? t(
              "专题报告已更新，并会作为有效上下文提供给统一分析体。",
              "レポートを更新し、有効なコンテキストとして統一分析体へ渡します。",
              "Report updated and supplied to the unified analyst as valid context.",
            )
          : t(
              "本轮缺少可验证的实时行情，已保留请求记录；行情恢复后可重新生成。",
              "検証可能なリアルタイム市場データが不足しています。要求は記録済みで、市場復旧後に再生成できます。",
              "This run lacked verifiable live market data. The request was recorded and can be regenerated when data resumes.",
            ),
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeTopic = async (topic: ResearchTopic) => {
    if (
      !window.confirm(
        t(
          `删除“${topic.name}”？既有报告将保留为审计记录。`,
          `「${topic.name}」を削除しますか？既存レポートは監査記録として保持されます。`,
          `Delete “${topic.name}”? Existing reports remain as audit records.`,
        ),
      )
    )
      return;
    setBusy(true);
    try {
      await request(`/v1/research/topics/${topic.id}`, { method: "DELETE" });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="market-research-panel">
      <div className="market-research-hero">
        <div>
          <p className="eyebrow">{t("圆衡研究层 · v1", "円衡リサーチ層 · v1", "ENKEI RESEARCH LAYER · v1")}</p>
          <h2>
            {t("市场专项追踪", "マーケット特別追跡", "Market research tracks")}
          </h2>
          <p>
            {t(
              "多品种、定时与事件/波动触发的研究报告。报告先存入圆衡研究库，仅在证据有效时压缩为统一分析体的上下文；它不拥有下单权限。",
              "複数銘柄の定時・イベント・変動トリガー研究です。レポートは円衡の研究庫に保存され、有効な証拠だけが統一分析体のコンテキストになります。注文権限はありません。",
              "Multi-instrument scheduled, event and volatility research. Reports persist in Enkei; only valid evidence is compressed into unified-agent context. It has no order authority.",
            )}
          </p>
        </div>
        <div className="market-research-metrics">
          <strong>{status?.enabled_topics ?? 0}</strong>
          <span>{t("启用专题", "有効な追跡", "active tracks")}</span>
          <strong>{status?.valid_reports ?? 0}</strong>
          <span>{t("有效报告", "有効レポート", "valid reports")}</span>
          <strong
            className={context?.context ? "context-ready" : "context-wait"}
          >
            {context?.context
              ? t("已接入", "接続済み", "linked")
              : t("待证据", "証拠待ち", "awaiting evidence")}
          </strong>
          <span>
            {t("统一分析体上下文", "統一分析体コンテキスト", "agent context")}
          </span>
        </div>
      </div>

      {notice && <p className="market-research-notice">{notice}</p>}
      <div className="market-research-layout">
        <section className="market-research-card topic-builder">
          <h3>
            {t("新建客户专题", "顧客トピックを作成", "Create a client track")}
          </h3>
          <form onSubmit={createTopic}>
            <label>
              <span>{t("品种代码", "シンボル", "Symbol")}</span>
              <input
                value={symbol}
                onChange={(event) =>
                  setSymbol(event.target.value.toUpperCase().replace(/\s/g, ""))
                }
                placeholder="USDJPY / EURUSD"
                required
                maxLength={18}
              />
            </label>
            <label>
              <span>{t("显示名称", "表示名", "Name")}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("可选", "任意", "Optional")}
                maxLength={64}
              />
            </label>
            <div className="market-research-form-grid">
              <label>
                <span>
                  {t(
                    "常规间隔（分钟）",
                    "通常間隔（分）",
                    "Interval (minutes)",
                  )}
                </span>
                <input
                  type="number"
                  min="5"
                  max="1440"
                  value={interval}
                  onChange={(event) => setIntervalMinutes(event.target.value)}
                  required
                />
              </label>
              <label>
                <span>
                  {t(
                    "波动阈值（pips）",
                    "変動しきい値（pips）",
                    "Volatility (pips)",
                  )}
                </span>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={volatility}
                  onChange={(event) => setVolatility(event.target.value)}
                  required
                />
              </label>
            </div>
            <details>
              <summary>
                {t(
                  "追加重要事件（可选）",
                  "重要イベントを追加（任意）",
                  "Add an important event (optional)",
                )}
              </summary>
              <div className="market-research-form-grid">
                <label>
                  <span>{t("事件名称", "イベント名", "Event")}</span>
                  <input
                    value={eventName}
                    onChange={(event) => setEventName(event.target.value)}
                    placeholder={t(
                      "例如：央行会议",
                      "例：中央銀行会合",
                      "e.g. central-bank meeting",
                    )}
                  />
                </label>
                <label>
                  <span>
                    {t("时间（本机时区）", "時刻（ローカル）", "Time (local)")}
                  </span>
                  <input
                    type="datetime-local"
                    value={eventAt}
                    onChange={(event) => setEventAt(event.target.value)}
                  />
                </label>
              </div>
              <p>
                {t(
                  "系统将在事件前后各 30 分钟尝试研究；可在后续版本调整窗口。",
                  "イベントの前後30分に研究を試みます。ウィンドウ調整は後続版で対応します。",
                  "The system attempts research 30 minutes before and after the event; configurable windows follow in a later update.",
                )}
              </p>
            </details>
            <button className="primary-btn" disabled={busy}>
              {t("创建专题", "トピックを作成", "Create track")}
            </button>
          </form>
          <p className="market-research-help">
            {t(
              "研究输入同时包含 MT4 实时报价、M5/M15 等已到达周期的最近K线与技术特征，以及相关宏观/FX 新闻。价格数据负责确认结构，新闻负责解释驱动和风险；缺少的数据会明确标注，不会编造。",
              "研究入力にはMT4リアルタイム価格、到着済みのM5/M15などの直近足とテクニカル特徴、関連するマクロ・FXニュースが含まれます。価格で構造を確認し、ニュースで要因とリスクを説明します。不足データは明示し、捏造しません。",
              "Research combines MT4 live quotes, recent bars and features for each available timeframe, and relevant macro/FX news. Price confirms structure; news explains drivers and risk. Missing inputs are identified, never invented.",
            )}
          </p>
        </section>

        <section className="market-research-card topic-list">
          <div className="topic-list-heading">
            <div>
              <h3>
                {t(
                  "专题模板与我的专题",
                  "テンプレートと自分の追跡",
                  "Templates and my tracks",
                )}
              </h3>
              <p>
                {t(
                  "内置模板默认关闭。启用状态保存在本机，下次启动会自动恢复。",
                  "内蔵テンプレートは初期状態でオフです。有効状態は端末に保存され、次回起動時に復元されます。",
                  "Built-in templates start off. Your choices persist locally and return on the next launch.",
                )}
              </p>
            </div>
          </div>
          {topics.length === 0 ? (
            <p className="empty-state">
              {t(
                "还没有专题。请从上方创建一个货币对或市场品种。",
                "まだトピックがありません。上で通貨ペアまたは市場銘柄を作成してください。",
                "No tracks yet. Create a currency pair or market symbol above.",
              )}
            </p>
          ) : (
            topics.map((topic) => (
              <article
                key={topic.id}
                className={selected?.id === topic.id ? "selected" : ""}
                onClick={() => void selectTopic(topic)}
              >
                <div>
                  <b>
                    {topicName(topic)}{" "}
                    {topic.preset && (
                      <em className="topic-preset-badge">
                        {t("内置", "内蔵", "Preset")}
                      </em>
                    )}
                  </b>
                  <span>
                    {topic.symbol} · {topic.interval_minutes}m ·{" "}
                    {topic.volatility_pips} pips
                  </span>
                  <small>
                    {t("上次：", "前回：", "Last: ")}
                    {localDate(topic.last_run_at)} · {topic.last_trigger || "—"}
                  </small>
                </div>
                <div className="topic-actions">
                  <label
                    className="switch-label"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={topic.enabled}
                      onChange={(event) =>
                        void updateTopic(topic, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                    <span>
                      {topic.enabled
                        ? t("已启用", "有効", "On")
                        : t("未启用", "無効", "Off")}
                    </span>
                  </label>
                  <button
                    disabled={busy || !topic.enabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runTopic(topic);
                    }}
                  >
                    {t("立即研究", "今すぐ研究", "Run now")}
                  </button>
                  {!topic.preset && (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeTopic(topic);
                      }}
                    >
                      {t("删除", "削除", "Delete")}
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      </div>

      <section className="market-research-card event-watch-section">
        <div className="report-heading">
          <div>
            <h3>{t("事件与异常波动监测", "イベント・異常変動監視", "Event & anomaly watch")}</h3>
            <p>{t(
              "计划事件与无新闻异常波动独立记录；触发后暂停沿用普通结论，M1只作证据，下一根完整M5确认后才恢复常规策略。",
              "予定イベントとニュース不明の異常変動を別々に記録します。起動後は通常判断を停止し、M1は証拠のみ、次の確定M5で再確認してから通常運用へ戻ります。",
              "Planned events and unexplained anomalies are logged separately. Normal conclusions pause; M1 is evidence only and normal policy resumes only after a closed M5 confirmation.",
            )}</p>
          </div>
          <span className={triggers.some((item) => item.normal_policy_suspended) ? "event-watch-active" : "event-watch-clear"}>
            {triggers.some((item) => item.normal_policy_suspended)
              ? t("事件模式生效", "イベントモード有効", "Event mode active")
              : t("常规监测", "通常監視", "Normal watch")}
          </span>
        </div>
        {triggers.length === 0 ? (
          <p className="empty-state">{t("当前没有触发记录。", "現在トリガー記録はありません。", "No trigger records yet.")}</p>
        ) : (
          <div className="event-watch-list">
            {triggers.map((item) => (
              <article key={item.id} className={item.normal_policy_suspended ? "active" : "confirmed"}>
                <header>
                  <div>
                    <b>{item.kind === "planned_event"
                      ? t("计划事件加班分析", "予定イベント臨時分析", "Planned-event overtime analysis")
                      : t("异常波动加班分析", "異常変動臨時分析", "Anomaly overtime analysis")}</b>
                    <span>{item.symbol} · {localDate(item.detected_at)} · {item.reason}</span>
                  </div>
                  <em>{item.status}</em>
                </header>
                <p>{t("来源周期", "検知足", "Detected on")}：{item.source_timeframe}　·　{t("正式确认", "正式確認", "Formal confirmation")}：{item.formal_decision_timeframe}</p>
                <p>{item.normal_policy_suspended
                  ? t("普通周期结论已暂停，等待完整 M5 复核。", "通常判断を停止し、確定M5の再確認待ちです。", "Normal-cycle conclusions are suspended pending a closed-M5 review.")
                  : t("M5 已完成复核，常规策略可以恢复。", "M5再確認済み。通常運用へ復帰できます。", "M5 review completed; normal policy may resume.")}</p>
                <small>{t("新闻解释", "ニュース説明", "News explanation")}：{item.news_explanation_found ? t("已找到", "確認済み", "found") : t("尚未确认", "未確認", "not confirmed")} · {t("报告", "レポート", "report")}：{item.report_id || "—"} · M5：{item.m5_confirmation_report_id || "—"}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="market-research-card report-section">
        <div className="report-heading">
          <div>
            <h3>
              {selected
                ? `${topicName(selected)} · ${selected.symbol}`
                : t("研究报告", "研究レポート", "Research reports")}
            </h3>
            <p>
              {t(
                "最近 8 条报告；仅有效且未过期的报告进入策略上下文。",
                "最新8件のレポート。有効かつ未期限切れのものだけが戦略コンテキストに入ります。",
                "Latest 8 reports. Only valid, unexpired reports enter policy context.",
              )}
            </p>
          </div>
          {selected && (
            <button
              className="primary-btn"
              disabled={busy}
              onClick={() => void runTopic(selected)}
            >
              {t("生成最新报告", "最新レポートを生成", "Generate latest")}
            </button>
          )}
        </div>
        {reports.length === 0 ? (
          <p className="empty-state">
            {t(
              "暂无报告。专题创建后可点击“立即研究”。",
              "レポートはありません。トピック作成後に「今すぐ研究」を押してください。",
              "No report yet. Click Run now after creating a track.",
            )}
          </p>
        ) : (
          reports.map((report) => (
            <article
              className={`research-report ${report.status}`}
              key={report.id}
            >
              <header>
                <div>
                  <span className={`research-status ${report.status}`}>
                    {report.status === "evidence_ready"
                      ? t(
                          "行情与证据有效",
                          "市場・証拠有効",
                          "Market & evidence ready",
                        )
                      : t("证据不足", "証拠不足", "Insufficient sources")}
                  </span>
                  <b>
                    {report.headline ||
                      t("未生成标题", "タイトル未生成", "No headline")}
                  </b>
                </div>
                <small>
                  {localDate(report.generated_at)} ·{" "}
                  {t("有效至", "有効期限", "Valid until")}{" "}
                  {localDate(report.valid_until)} ·{" "}
                  {reportValue(report.trigger)}
                </small>
              </header>
              <p className="research-thesis">
                <strong>{t("短线", "短期", "Short")}</strong>{" "}
                {reportValue(report.thesis?.short_bias)}　
                <strong>{t("中期", "中期", "Medium")}</strong>{" "}
                {reportValue(report.thesis?.mid_bias)}　
                <strong>{t("置信度", "確信度", "Confidence")}</strong>{" "}
                {report.thesis?.confidence ?? "—"}
              </p>
              <p className="research-summary">
                {report.thesis?.summary ||
                  report.thesis?.rationale ||
                  t(
                    "本轮没有生成可展示的分析摘要。",
                    "表示可能な分析要約がありません。",
                    "No displayable analysis summary was generated.",
                  )}
              </p>
              <div className="research-report-grid">
                <div>
                  <h4>{t("驱动因素", "ドライバー", "Drivers")}</h4>
                  <ul>
                    {report.drivers?.length ? (
                      report.drivers.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))
                    ) : (
                      <li>—</li>
                    )}
                  </ul>
                </div>
                <div>
                  <h4>{t("关键位置", "重要水準", "Key levels")}</h4>
                  <ul>
                    {report.key_levels?.length ? (
                      report.key_levels.map((item, index) => (
                        <li key={index}>
                          {typeof item === "string"
                            ? item
                            : [item.label, item.value, item.meaning]
                                .filter(Boolean)
                                .join(" · ")}
                        </li>
                      ))
                    ) : (
                      <li>—</li>
                    )}
                  </ul>
                </div>
                <div>
                  <h4>{t("风险与复核", "リスクと再確認", "Risks & checks")}</h4>
                  <ul>
                    {[...(report.risks ?? []), ...(report.next_checks ?? [])]
                      .length ? (
                      [
                        ...(report.risks ?? []),
                        ...(report.next_checks ?? []),
                      ].map((item, index) => <li key={index}>{item}</li>)
                    ) : (
                      <li>—</li>
                    )}
                  </ul>
                </div>
              </div>
              <p className="source-assessment">
                {report.source_assessment ||
                  t(
                    "来源评估缺失。",
                    "ソース評価なし。",
                    "No source assessment.",
                  )}
              </p>
              <details className="research-protocol-details">
                <summary>{t("完整分析协议", "完全分析プロトコル", "Full analysis protocol")}</summary>
                <div className="research-protocol-grid">
                  <div><h4>{t("数据状态", "データ状態", "Data status")}</h4><pre>{readable(report.data_status ?? {})}</pre></div>
                  <div><h4>{t("关联市场", "関連市場", "Related markets")}</h4><ul>{(report.related_markets ?? []).map((item, index) => <li key={index}>{readable(item)}</li>)}</ul></div>
                  <div><h4>{t("重要事件", "重要イベント", "Important events")}</h4><ul>{(report.event_assessment ?? []).map((item, index) => <li key={index}>{readable(item)}</li>)}</ul></div>
                  <div><h4>{t("传统逻辑与背离", "従来ロジックと乖離", "Logic and divergence")}</h4><pre>{readable(report.logic_consistency ?? {})}</pre></div>
                  <div><h4>{t("多空与观望证据", "売買・待機の根拠", "Bull, bear and wait evidence")}</h4><pre>{readable(report.evidence_balance ?? {})}</pre></div>
                  <div><h4>{t("三种情景", "3つのシナリオ", "Three scenarios")}</h4><pre>{readable(report.scenarios ?? {})}</pre></div>
                  <div><h4>{t("最终判断与失效条件", "最終判断と無効条件", "Final judgement and invalidation")}</h4><pre>{readable(report.final_judgment ?? {})}</pre></div>
                  <div><h4>{t("相对上次变化", "前回からの変化", "Change from previous")}</h4><pre>{readable(report.change_from_previous ?? {})}</pre></div>
                </div>
                <div className="research-content-classes">
                  <div><b>{t("已验证事实", "確認済み事実", "Verified facts")}</b>{(report.verified_facts ?? []).map((item, index) => <p key={index}>{readable(item)}</p>)}</div>
                  <div><b>{t("AI 推断", "AI推論", "AI inferences")}</b>{(report.inferences ?? []).map((item, index) => <p key={index}>{readable(item)}</p>)}</div>
                  <div><b>{t("系统建议", "システム提案", "System recommendations")}</b>{(report.system_recommendations ?? []).map((item, index) => <p key={index}>{readable(item)}</p>)}</div>
                </div>
              </details>
              <details>
                <summary>
                  {t(
                    `新闻证据（${report.sources?.length ?? 0}）`,
                    `ニュース証拠（${report.sources?.length ?? 0}）`,
                    `News evidence (${report.sources?.length ?? 0})`,
                  )}
                </summary>
                <ul className="research-sources">
                  {report.sources?.map((source, index) => (
                    <li key={index}>
                      {source.link ? (
                        <a href={source.link} target="_blank" rel="noreferrer">
                          {source.display || source.title || source.link}
                        </a>
                      ) : (
                        source.display || source.title || "—"
                      )}{" "}
                      <small>
                        {source.published ? localDate(source.published) : ""}
                      </small>
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
