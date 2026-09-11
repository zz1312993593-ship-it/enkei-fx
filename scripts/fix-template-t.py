# -*- coding: utf-8 -*-
"""批1修复：为模板字符串 t() 调用补英文第三参（幂等：已应用则跳过）。"""
import io

def apply(path, subs):
    s = io.open(path, encoding='utf-8').read()
    done = 0
    for old, new in subs:
        if new in s:
            done += 1  # already applied
            continue
        assert s.count(old) == 1, f'{path} not unique or missing: {old[:70]}'
        s = s.replace(old, new)
        done += 1
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'{path}: {done}/{len(subs)} ok')

apply('app/backtest-panel.tsx', [
    ("t(`已在本机读取 ${parsed.bars.length.toLocaleString()} 根K线${discarded ? `；忽略 ${discarded} 行无效或重复数据` : ''}。`, `${parsed.bars.length.toLocaleString()}本の足を端末内で読み込みました${discarded ? `（無効・重複 ${discarded}行を除外）` : ''}。`)",
     "t(`已在本机读取 ${parsed.bars.length.toLocaleString()} 根K线${discarded ? `；忽略 ${discarded} 行无效或重复数据` : ''}。`, `${parsed.bars.length.toLocaleString()}本の足を端末内で読み込みました${discarded ? `（無効・重複 ${discarded}行を除外）` : ''}。`, `Read ${parsed.bars.length.toLocaleString()} candles locally${discarded ? `; skipped ${discarded} invalid or duplicate rows` : ''}.`)"),
    ("t(`当前结果来自 MT4 只读导出的 ${timeframe} 历史（共 ${bridgeHistoryTotal.toLocaleString()} 根）；不含任何下单接口。`, `現在の結果はMT4読取専用の${timeframe}履歴（全${bridgeHistoryTotal.toLocaleString()}本）によるものです。注文機能は含みません。`)",
     "t(`当前结果来自 MT4 只读导出的 ${timeframe} 历史（共 ${bridgeHistoryTotal.toLocaleString()} 根）；不含任何下单接口。`, `現在の結果はMT4読取専用の${timeframe}履歴（全${bridgeHistoryTotal.toLocaleString()}本）によるものです。注文機能は含みません。`, `These results come from the MT4 read-only ${timeframe} export (${bridgeHistoryTotal.toLocaleString()} candles); it contains no order interface.`)"),
    ("t(`当前筛选后：${bars.length.toLocaleString()} 根K线。若不足以完成策略预热，将明确显示没有交易，而不会伪造结果。`, `現在の絞り込み後：${bars.length.toLocaleString()}本。戦略の準備期間に不足する場合は取引なしと明示し、結果を作りません。`)",
     "t(`当前筛选后：${bars.length.toLocaleString()} 根K线。若不足以完成策略预热，将明确显示没有交易，而不会伪造结果。`, `現在の絞り込み後：${bars.length.toLocaleString()}本。戦略の準備期間に不足する場合は取引なしと明示し、結果を作りません。`, `After filtering: ${bars.length.toLocaleString()} candles. If too few to warm up the strategy, no trades is shown explicitly instead of fabricating results.`)"),
])

apply('app/data-health-panel.tsx', [
    ("t(`已校正 ${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}h`, `${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}時間を補正`)",
     "t(`已校正 ${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}h`, `${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}時間を補正`, `Adjusted ${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}h`)"),
    ("t(`${symbol} 的 ${timeframe} 数据已通过本机来源与周期检查；缺口会保留显示，不能被策略结果忽略。`, `${symbol}の${timeframe}データは端末内ソースと時間足を確認済みです。欠損は表示を残し、戦略結果で無視しません。`)",
     "t(`${symbol} 的 ${timeframe} 数据已通过本机来源与周期检查；缺口会保留显示，不能被策略结果忽略。`, `${symbol}の${timeframe}データは端末内ソースと時間足を確認済みです。欠損は表示を残し、戦略結果で無視しません。`, `${symbol} ${timeframe} data passed the local source and timeframe checks; gaps stay visible and cannot be ignored by strategy results.`)"),
    ("t(`${symbol} 的 ${timeframe} 历史或 MT4 时钟尚未通过核对。此时不能作为真实回测样本，也不能进入第一、二阶段验收。`, `${symbol}の${timeframe}履歴またはMT4時刻は未確認です。この間は実データの検証や第1・第2段階の検収には使用しません。`)",
     "t(`${symbol} 的 ${timeframe} 历史或 MT4 时钟尚未通过核对。此时不能作为真实回测样本，也不能进入第一、二阶段验收。`, `${symbol}の${timeframe}履歴またはMT4時刻は未確認です。この間は実データの検証や第1・第2段階の検収には使用しません。`, `${symbol} ${timeframe} history or the MT4 clock has not passed verification yet. It cannot serve as real backtest samples or enter stage-1/2 acceptance.`)"),
])

apply('app/demo-execution-panel.tsx', [
    ("t(`风险抽屉点差上限：${risk.maxSpreadPips.toFixed(1)} pips；EA 将在执行前再检查。`, `リスク設定のスプレッド上限：${risk.maxSpreadPips.toFixed(1)} pips。EAが実行前に再確認します。`)",
     "t(`风险抽屉点差上限：${risk.maxSpreadPips.toFixed(1)} pips；EA 将在执行前再检查。`, `リスク設定のスプレッド上限：${risk.maxSpreadPips.toFixed(1)} pips。EAが実行前に再確認します。`, `Risk drawer spread cap: ${risk.maxSpreadPips.toFixed(1)} pips; the EA re-checks before execution.`)"),
    ("t(`当前浏览器已采样 ${ticks.length} 个秒级报价点；离开页面不会作为历史保存。`, `このブラウザで ${ticks.length} 件の秒次レートを取得済み。画面を離れると履歴として保存されません。`)",
     "t(`当前浏览器已采样 ${ticks.length} 个秒级报价点；离开页面不会作为历史保存。`, `このブラウザで ${ticks.length} 件の秒次レートを取得済み。画面を離れると履歴として保存されません。`, `This browser has sampled ${ticks.length} per-second quote points; leaving the page does not keep them as history.`)"),
])
