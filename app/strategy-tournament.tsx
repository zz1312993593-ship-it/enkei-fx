'use client';

import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_BACKTEST_CONFIG, runBacktest } from '../lib/backtest';
import { RESEARCH_MODELS, modelDefinition, modelLogic, modelName, modelShort, type ResearchModel } from '../lib/model-catalog';
import type { Mt4HistorySnapshot } from '../lib/mt4-bridge';
import { QUOTES, type OhlcBar, type PairSymbol, type RiskConfig, type Timeframe } from '../lib/market-data';

type Language = 'zh' | 'ja' | 'en';
type SourceState = 'loading' | 'ready' | 'not-ready' | 'unavailable';

interface PairHistory {
  symbol: PairSymbol;
  state: SourceState;
  bars: OhlcBar[];
  totalBars: number;
  latestBarTime: number | null;
  reason?: string;
}

interface PairResult {
  symbol: PairSymbol;
  netReturnPct: number;
  maxDrawdownPct: number;
  totalTrades: number;
  profitFactor: number;
  pass: boolean;
}

interface TournamentRun {
  model: ResearchModel;
  rows: PairResult[];
  averageReturnPct: number;
  worstDrawdownPct: number;
  totalTrades: number;
  score: number;
  passCount: number;
  forwardEligible: boolean;
}

function profileSettings(profile: number) {
  const ratio = profile / 100;
  return {
    fastEma: Math.round(22 - ratio * 16),
    slowEma: Math.round(58 - ratio * 40),
    breakoutLookback: Math.round(32 - ratio * 24),
    stopAtr: Number((2.4 - ratio * 1.4).toFixed(1)),
    rewardRisk: Number((1.5 + ratio * 1.4).toFixed(1)),
    maxHoldingBars: Math.round(72 - ratio * 56),
  };
}

function canUseHistory(history: Mt4HistorySnapshot) {
  return history.bars.length >= 600 && (history.clock.status === 'aligned' || history.clock.status === 'offset-corrected');
}

function loadQueue() {
  if (typeof window === 'undefined') return [] as Array<{ model: ResearchModel; time: string; score: number }>;
  try { return JSON.parse(window.localStorage.getItem('enkei-forward-paper-queue') ?? '[]') as Array<{ model: ResearchModel; time: string; score: number }>; } catch { return []; }
}

export default function StrategyTournament({ language, timeframe, risk, activeModel, onModelChange, displayTimeZone = 'Asia/Tokyo' }: { language: Language; timeframe: Timeframe; risk: RiskConfig; activeModel: ResearchModel; onModelChange: (model: ResearchModel) => void; displayTimeZone?: string }) {
  const [profile, setProfile] = useState(45);
  const [minimumTrades, setMinimumTrades] = useState(10);
  const [maximumDrawdown, setMaximumDrawdown] = useState(8);
  const [histories, setHistories] = useState<PairHistory[]>(() => QUOTES.map((quote) => ({ symbol: quote.symbol, state: 'loading', bars: [], totalBars: 0, latestBarTime: null })));
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [queue, setQueue] = useState(loadQueue);
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;

  useEffect(() => {
    let alive = true;
    async function loadHistory() {
      setHistories(QUOTES.map((quote) => ({ symbol: quote.symbol, state: 'loading', bars: [], totalBars: 0, latestBarTime: null })));
      const next = await Promise.all(QUOTES.map(async (quote): Promise<PairHistory> => {
        try {
          const analysisLimit = timeframe === 'M1' ? 3000 : timeframe === 'M5' || timeframe === 'M15' ? 5000 : 8000;
          const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(quote.symbol.replace('/', ''))}&timeframe=${timeframe}&limit=${analysisLimit}`);
          if (!response.ok) throw new Error('history unavailable');
          const history = await response.json() as Mt4HistorySnapshot;
          if (!canUseHistory(history)) {
            return { symbol: quote.symbol, state: 'not-ready', bars: [], totalBars: history.total_bars, latestBarTime: history.latest_bar_time, reason: history.clock.status === 'unresolved' ? 'clock' : 'bars' };
          }
          return { symbol: quote.symbol, state: 'ready', bars: history.bars, totalBars: history.total_bars, latestBarTime: history.latest_bar_time };
        } catch {
          return { symbol: quote.symbol, state: 'unavailable', bars: [], totalBars: 0, latestBarTime: null };
        }
      }));
      if (alive) {
        setHistories(next);
        setLoadedAt(Date.now());
      }
    }
    void loadHistory();
    return () => { alive = false; };
  }, [refreshKey, timeframe]);

  const readyHistories = useMemo(() => histories.filter((item) => item.state === 'ready'), [histories]);
  const runs = useMemo<TournamentRun[]>(() => {
    const settings = profileSettings(profile);
    return RESEARCH_MODELS.map((definition) => {
      const rows = readyHistories.map((history) => {
        const quote = QUOTES.find((item) => item.symbol === history.symbol) ?? QUOTES[0];
        const startIndex = Math.max(0, Math.floor(history.bars.length * 0.7));
        const result = runBacktest(history.bars, {
          ...DEFAULT_BACKTEST_CONFIG,
          ...settings,
          symbol: history.symbol,
          timeframe,
          riskPerTradePct: risk.riskPerTradePct,
          spreadPips: quote.spreadPips,
          entryModel: definition.id,
          startIndex,
        });
        const pass = result.totalTrades >= minimumTrades && result.maxDrawdownPct <= maximumDrawdown && result.netReturnPct > 0 && result.profitFactor > 1;
        return { symbol: history.symbol, netReturnPct: result.netReturnPct, maxDrawdownPct: result.maxDrawdownPct, totalTrades: result.totalTrades, profitFactor: result.profitFactor, pass };
      });
      const averageReturnPct = rows.length ? rows.reduce((sum, item) => sum + item.netReturnPct, 0) / rows.length : 0;
      const worstDrawdownPct = rows.length ? Math.max(...rows.map((item) => item.maxDrawdownPct)) : 0;
      const totalTrades = rows.reduce((sum, item) => sum + item.totalTrades, 0);
      const passCount = rows.filter((item) => item.pass).length;
      const forwardEligible = readyHistories.length >= 2 && passCount >= 2;
      const score = rows.length ? averageReturnPct * 12 + passCount * 18 - worstDrawdownPct * 2 + Math.min(totalTrades, 120) * 0.08 : Number.NEGATIVE_INFINITY;
      return { model: definition.id, rows, averageReturnPct, worstDrawdownPct, totalTrades, score, passCount, forwardEligible };
    }).sort((left, right) => Number(right.forwardEligible) - Number(left.forwardEligible) || right.score - left.score);
  }, [maximumDrawdown, minimumTrades, profile, readyHistories, risk.riskPerTradePct, timeframe]);

  const queueCandidate = (run: TournamentRun) => {
    if (!run.forwardEligible) return;
    const next = [{ model: run.model, time: new Date().toISOString(), score: run.score }, ...queue.filter((item) => item.model !== run.model)].slice(0, 5);
    setQueue(next);
    window.localStorage.setItem('enkei-forward-paper-queue', JSON.stringify(next));
  };

  const exportResearch = () => {
    const payload = { generatedAt: new Date().toISOString(), timeframe, profile, minimumTrades, maximumDrawdown, source: 'mt4-local-history-read-only', ranking: runs, note: 'Research ranking only. No order, account, or broker access is included.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `enkei-strategy-tournament-${timeframe}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const stateLabel = (item: PairHistory) => item.state === 'loading' ? t('读取中', '読込中', 'Loading') : item.state === 'ready' ? t('可参赛', '参加可能', 'Eligible') : item.state === 'not-ready' ? item.reason === 'clock' ? t('时钟待校准', '時刻補正待ち', 'Clock awaiting calibration') : t('历史不足', '履歴不足', 'Insufficient history') : t('未连接', '未接続', 'Not connected');
  const best = runs.find((run) => run.forwardEligible);

  return <section className="phase-panel tournament-panel">
    <div className="phase-heading">
      <div><p className="eyebrow">PHASE 5 · STRATEGY TOURNAMENT</p><h3>{t('策略筛选与淘汰中心', 'ストラテジー選抜・淘汰センター', 'Strategy selection & elimination centre')} <span>{t('同规则 · 样本外 · 跨市场', '同一条件・アウトオブサンプル・市場横断', 'Same rules · out-of-sample · cross-market')}</span></h3></div>
      <span className="model-local-chip">{t('只读 MT4 历史 · 研究排名', '読取専用 MT4履歴・研究順位', 'Read-only MT4 history · research ranking')}</span>
    </div>

    <div className="tournament-safety"><span>◈</span><p><b>{t('这里不寻找“保证盈利”的模型，而是用公开规则淘汰不稳定模型。', 'ここでは「必ず利益が出る」モデルを探さず、公開ルールで不安定なモデルを淘汰します。', 'This does not hunt for “guaranteed profit” models; it eliminates unstable ones by public rules.')}</b><small>{t('仅使用已校准的本机 MT4 历史；没有实际历史就不排名，不用演示数据补位。入选只进入本机前向模拟候选队列，不会下单。', '補正済みの端末内 MT4履歴だけを使用します。実履歴がなければ順位付けせず、デモデータで補いません。通過しても端末内フォワード検証候補になるだけで、注文は出しません。', 'Only calibrated local MT4 history is used; without real history nothing is ranked and demo data is never substituted. Selection only enters the local forward-simulation candidate queue and places no orders.')}</small></p></div>

    <div className="tournament-controls">
      <label><span>{t('策略风险谱', '戦略リスクスペクトラム', 'Strategy risk spectrum')}</span><b>{profile}/100</b><input type="range" min="0" max="100" step="1" value={profile} onChange={(event) => setProfile(Number(event.target.value))} /><small>{t('左侧更慢、更稳；右侧更快、更积极。所有模型使用同一位置。', '左ほど低速・保守、右ほど高速・積極。同じ位置を全モデルに適用します。', 'Slower and steadier on the left; faster and more aggressive on the right. All models use the same position.')}</small></label>
      <label><span>{t('最低样本外交易数', '最小アウトオブサンプル取引数', 'Minimum out-of-sample trades')}</span><b>{minimumTrades}</b><input type="range" min="4" max="40" step="1" value={minimumTrades} onChange={(event) => setMinimumTrades(Number(event.target.value))} /><small>{t('交易数不足不会被判定为优秀。', '取引数不足は優秀と判定しません。', 'Too few trades is never judged excellent.')}</small></label>
      <label><span>{t('最大允许回撤', '許容最大ドローダウン', 'Maximum allowed drawdown')}</span><b>{maximumDrawdown.toFixed(1)}%</b><input type="range" min="2" max="20" step="0.5" value={maximumDrawdown} onChange={(event) => setMaximumDrawdown(Number(event.target.value))} /><small>{t('使用样本外权益曲线的最大回撤。', 'アウトオブサンプルの損益曲線における最大下落です。', 'Uses the max drawdown of the out-of-sample equity curve.')}</small></label>
      <div className="tournament-actions"><button onClick={() => setRefreshKey((value) => value + 1)}>{t('刷新本机历史', '端末内履歴を更新', 'Refresh local history')}</button><button onClick={exportResearch} disabled={!readyHistories.length}>{t('导出研究结果', '研究結果を書き出す', 'Export research results')}</button><small>{loadedAt ? `${t('上次读取', '最終読込', 'Last read')}: ${new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(loadedAt))}` : t('等待本机桥', '端末内ブリッジ待機', 'Waiting for the local bridge')}</small></div>
    </div>

    <div className="tournament-data-grid">
      {histories.map((item) => <article className={`tournament-source ${item.state}`} key={item.symbol}><div><b>{item.symbol}</b><span>{stateLabel(item)}</span></div><strong>{item.totalBars ? item.totalBars.toLocaleString() : '—'}</strong><small>{item.totalBars ? `${timeframe} · ${t('实际K线', '実履歴足', 'Real candles')}` : t('不参与排名', '順位対象外', 'Not ranked')}</small></article>)}
    </div>

    <div className="tournament-summary"><div><span>{t('当前参赛市场', '現在の参加市場', 'Markets currently competing')}</span><b>{readyHistories.length} / {QUOTES.length}</b><small>{t('至少 2 个市场通过，模型才可进入前向模拟候选。', '2市場以上の通過で初めてフォワード検証候補になります。', 'A model needs at least 2 passing markets to become a forward-simulation candidate.')}</small></div><div><span>{t('统一成本', '共通コスト', 'Common cost')}</span><b>{t('点差 + 0.2 pips 滑点', 'スプレッド + 0.2 pipsスリッページ', 'Spread + 0.2 pips slippage')}</b><small>{t('按每个货币对的当前固定研究假设计入。', '各通貨ペアの固定研究仮定として計上します。', 'Charged per pair under the current fixed research assumptions.')}</small></div><div><span>{t('样本外切分', 'アウトオブサンプル分割', 'Out-of-sample split')}</span><b>70% / 30%</b><small>{t('前 70% 预热，最后 30% 统一比较。', '先頭70%でウォームアップし、最後の30%で統一比較します。', 'First 70% warms up; the last 30% is compared uniformly.')}</small></div><div><span>{t('研究队列', '研究キュー', 'Research queue')}</span><b>{queue.length}</b><small>{queue[0] ? `${modelShort(modelDefinition(queue[0].model), language)} · ${t('本机保存', '端末内保存', 'Saved locally')}` : t('尚无候选', '候補なし', 'No candidates yet')}</small></div></div>

    {!readyHistories.length ? <div className="tournament-empty"><b>{t('还没有符合条件的实际历史。', '条件を満たす実履歴がまだありません。', 'No qualifying real history yet.')}</b><p>{t(`请让 MT4 只读桥完成 ${timeframe} 历史和时钟校准；这里将保持空白，而不是以演示数据做出虚假排名。`, `MT4読取専用ブリッジで ${timeframe} 履歴と時刻補正を完了してください。デモデータによる虚偽の順位は表示しません。`, `Let the MT4 read-only bridge finish ${timeframe} history and clock calibration; this stays blank rather than fabricating a ranking from demo data.`)}</p></div> : <div className="tournament-ranking">
      {runs.map((run, index) => {
        const definition = modelDefinition(run.model);
        const selected = run.model === activeModel;
        return <article className={`tournament-card color-${definition.color} ${selected ? 'active' : ''}`} key={run.model}>
          <header><span>#{index + 1}</span><b>{run.forwardEligible ? t('前向模拟候选', 'フォワード検証候補', 'Forward-simulation candidates') : t('淘汰 / 继续观察', '淘汰 / 継続観察', 'Eliminated / keep observing')}</b></header>
          <h4>{modelName(definition, language)}</h4><p>{modelLogic(definition, language)}</p>
          <div className="tournament-metrics"><span><small>{t('研究分', '研究スコア', 'Research score')}</small><b>{Number.isFinite(run.score) ? run.score.toFixed(1) : '—'}</b></span><span><small>{t('平均样本外', '平均OOS', 'Average out-of-sample')}</small><b className={run.averageReturnPct > 0 ? 'positive' : 'negative'}>{run.averageReturnPct.toFixed(2)}%</b></span><span><small>{t('最差回撤', '最大DD', 'Worst drawdown')}</small><b>{run.worstDrawdownPct.toFixed(2)}%</b></span><span><small>{t('通过市场', '通過市場', 'Markets passed')}</small><b>{run.passCount}/{readyHistories.length}</b></span></div>
          <div className="tournament-pairs">{run.rows.map((row) => <span className={row.pass ? 'pass' : 'fail'} key={row.symbol}>{row.symbol} · {row.netReturnPct.toFixed(2)}% · {row.totalTrades}T</span>)}</div>
          <footer><button onClick={() => onModelChange(run.model)} disabled={selected}>{selected ? t('当前研究模型', '現在の研究モデル', 'Current research model') : t('设为研究模型', '研究モデルに設定', 'Set as research model')}</button><button className="queue-button" onClick={() => queueCandidate(run)} disabled={!run.forwardEligible}>{queue.some((item) => item.model === run.model) ? t('已在候选队列', '候補キュー済み', 'Already in the candidate queue') : t('加入前向模拟候选', '前向検証候補へ', 'Add to forward-simulation candidates')}</button></footer>
        </article>;
      })}
    </div>}

    <div className="tournament-rules"><article><p className="eyebrow">ELIMINATION RULES</p><b>{t('淘汰规则完全可见', '淘汰ルールは完全公開', 'Elimination rules fully visible')}</b><span>{t(`每个市场必须同时满足：样本外收益为正、利润因子大于 1、交易数不少于 ${minimumTrades}、回撤不高于 ${maximumDrawdown.toFixed(1)}%。`, `各市場でOOS収益が正、プロフィットファクターが1超、取引数${minimumTrades}以上、DDが${maximumDrawdown.toFixed(1)}%以下をすべて満たす必要があります。`, `Every market must simultaneously show positive out-of-sample return, profit factor above 1, at least ${minimumTrades} trades and drawdown no worse than ${maximumDrawdown.toFixed(1)}%.`)}</span></article><article><p className="eyebrow">FORWARD QUEUE</p><b>{t('候选不是启用', '候補は有効化ではありません', 'A candidate is not an enablement')}</b><span>{best ? t('当前已有达到两市场门槛的候选；它仍需在内部模拟与人工复核中继续观察。', '現在は2市場基準を満たす候補があります。内部ペーパーと人による再確認で継続観察が必要です。', 'A candidate has reached the two-market threshold; it still needs continued observation in internal simulation and human review.') : t('目前没有模型达到两市场门槛；这是正常的研究结论，不应强行选择赢家。', '現在2市場基準を満たすモデルはありません。これは正常な研究結果で、無理に勝者を選びません。', 'No model has reached the two-market threshold yet; that is a normal research outcome, and winners should not be forced.')}</span></article><article><p className="eyebrow">SAFETY LOCK</p><b>{t('无订单、无账户、无自动执行', '注文なし・口座なし・自動実行なし', 'No orders, no account, no automatic execution')}</b><span>{t('本页只读取 127.0.0.1 的本机历史，并将候选记录到浏览器本机。', 'このページは127.0.0.1の端末内履歴を読むだけで、候補はブラウザ内にだけ記録します。', 'This page only reads local history from 127.0.0.1 and records candidates in this browser.')}</span></article></div>
  </section>;
}
