export type ResearchModel = 'trend-breakout' | 'ema-cross' | 'trend-pullback' | 'range-reversion' | 'momentum-pulse' | 'session-breakout' | 'atr-channel' | 'asia-range';

export interface ResearchModelDefinition {
  id: ResearchModel;
  version: string;
  zh: string;
  ja: string;
  en: string;
  shortZh: string;
  shortJa: string;
  shortEn: string;
  regimeZh: string;
  regimeJa: string;
  regimeEn: string;
  logicZh: string;
  logicJa: string;
  logicEn: string;
  color: 'green' | 'blue' | 'gold' | 'violet' | 'red';
}

export const RESEARCH_MODELS: ResearchModelDefinition[] = [
  { id: 'trend-breakout', version: '0.5', zh: '趋势突破', ja: 'トレンド・ブレイク', en: 'Trend breakout', shortZh: '顺势突破', shortJa: '順張りブレイク', shortEn: 'With-trend breakout', regimeZh: '趋势延续、区间突破', regimeJa: 'トレンド継続・レンジ離脱', regimeEn: 'Trend continuation, range exits', logicZh: '快慢均线同向后，仅在完整K线收盘突破近期区间时观察。', logicJa: '短期・長期移動平均が同方向のとき、確定足の直近レンジ離脱だけを観測します。', logicEn: 'When fast and slow EMAs agree, it only observes closes that break the recent range on completed candles.', color: 'green' },
  { id: 'ema-cross', version: '0.5', zh: '均线交叉', ja: '移動平均クロス', en: 'EMA cross', shortZh: '趋势转换', shortJa: '転換観測', shortEn: 'Trend shift', regimeZh: '趋势转换', regimeJa: 'トレンド転換', regimeEn: 'Trend transitions', logicZh: '仅在完整K线确认快慢均线刚发生交叉时观察。', logicJa: '確定足で短期・長期移動平均の交差が発生した時だけ観測します。', logicEn: 'It observes only fresh fast/slow EMA crosses confirmed on completed candles.', color: 'blue' },
  { id: 'trend-pullback', version: '0.5', zh: '趋势回踩', ja: 'トレンド押し目', en: 'Trend pullback', shortZh: '顺势回踩', shortJa: '順張り押し目', shortEn: 'With-trend dip', regimeZh: '趋势中回撤', regimeJa: 'トレンド中の押し戻し', regimeEn: 'Pullbacks inside a trend', logicZh: '趋势仍在时，价格回到快均线后再以收盘确认。', logicJa: 'トレンド継続中に価格が短期線へ戻り、終値で再確認した場合だけ観測します。', logicEn: 'While the trend holds, it observes dips back to the fast EMA confirmed by the close.', color: 'gold' },
  { id: 'range-reversion', version: '0.5', zh: '区间回归', ja: 'レンジ回帰', en: 'Range reversion', shortZh: '均值回归', shortJa: '平均回帰', shortEn: 'Mean reversion', regimeZh: '低趋势、横盘区间', regimeJa: '低トレンド・レンジ相場', regimeEn: 'Low-trend, ranging markets', logicZh: '仅在均线分离较小的区间中，观察价格自区间边缘回归。', logicJa: '移動平均の乖離が小さいレンジで、端からの平均回帰のみを観測します。', logicEn: 'It observes mean reversion from range edges only while EMA separation stays small.', color: 'violet' },
  { id: 'momentum-pulse', version: '0.5', zh: '动量脉冲', ja: 'モメンタム・パルス', en: 'Momentum pulse', shortZh: '短线动量', shortJa: '短期モメンタム', shortEn: 'Short-term momentum', regimeZh: '波动扩张', regimeJa: 'ボラティリティ拡大', regimeEn: 'Volatility expansion', logicZh: '以完整K线的短线变动相对近期真实波幅进行观察。', logicJa: '確定足の短期変動を直近の真の値幅と比較して観測します。', logicEn: 'It observes short-term moves on completed candles against recent true range.', color: 'red' },
  // 以下三个为公开域经典思想的自研实现（只借鉴思想，不复刻任何第三方代码）：
  // 时段突破（session-breakout）思想、波动通道顺势（atr-channel）思想、亚洲区间回归（asia-range）思想。
  { id: 'session-breakout', version: '0.6', zh: '时段突破', ja: 'セッション突破', en: 'Session breakout', shortZh: '伦敦突破', shortJa: 'ロンドン突破', shortEn: 'London breakout', regimeZh: '亚洲盘整、欧洲扩张', regimeJa: 'アジアもみ合い・欧州拡大', regimeEn: 'Asian range, London expansion', logicZh: '亚洲时段（UTC 0–7 点）形成区间后，仅在伦敦时段（UTC 7–16 点）以完整K线收盘突破区间边缘时观察。', logicJa: 'アジア時間（UTC0–7時）のレンジを、ロンドン時間（UTC7–16時）の確定足が抜けた時だけ観測します。', logicEn: 'After an Asian-session range (UTC 00:00–07:00), it only observes London-session closes (UTC 07:00–16:00) beyond the range edge.', color: 'blue' },
  { id: 'atr-channel', version: '0.6', zh: '波动通道', ja: 'ATRチャネル', en: 'ATR channel', shortZh: '波动顺势', shortJa: 'ボラ順張り', shortEn: 'Volatility with-trend', regimeZh: '趋势伴随波动扩张', regimeJa: 'トレンド＋ボラ拡大', regimeEn: 'Trending with expanding volatility', logicZh: '在快慢均线同向时，仅观察收盘价越过近期高点/低点再叠加 ATR 一小段缓冲的方向。', logicJa: 'EMAが同方向のとき、直近高値・安値にATR分のバッファを越えた終値だけを観測します。', logicEn: 'When EMAs agree, it only observes closes beyond the recent extreme plus a small ATR buffer.', color: 'green' },
  { id: 'asia-range', version: '0.6', zh: '亚洲区间回归', ja: 'アジアレンジ回帰', en: 'Asia-range reversion', shortZh: '区间回归', shortJa: 'レンジ回帰', shortEn: 'Range reversion', regimeZh: '亚洲区间外的回归确认', regimeJa: 'アジアレンジ外からの回帰確認', regimeEn: 'Reversion back into the Asian range', logicZh: '价格脱离亚洲区间后，仅观察收盘价重新回到区间内的确认（脱离越远、缓冲越大）。', logicJa: 'アジアレンジを離脱した後、終値がレンジ内へ戻った確認だけを観測します。', logicEn: 'After leaving the Asian range, it only observes closes confirming a return back inside the range.', color: 'violet' },
];

export function modelDefinition(id: ResearchModel) {
  return RESEARCH_MODELS.find((model) => model.id === id) ?? RESEARCH_MODELS[0];
}

export type UiLanguage = 'zh' | 'ja' | 'en';

export function modelName(def: ResearchModelDefinition, language: UiLanguage): string {
  return language === 'zh' ? def.zh : language === 'ja' ? def.ja : def.en;
}

export function modelShort(def: ResearchModelDefinition, language: UiLanguage): string {
  return language === 'zh' ? def.shortZh : language === 'ja' ? def.shortJa : def.shortEn;
}

export function modelRegime(def: ResearchModelDefinition, language: UiLanguage): string {
  return language === 'zh' ? def.regimeZh : language === 'ja' ? def.regimeJa : def.regimeEn;
}

export function modelLogic(def: ResearchModelDefinition, language: UiLanguage): string {
  return language === 'zh' ? def.logicZh : language === 'ja' ? def.logicJa : def.logicEn;
}
