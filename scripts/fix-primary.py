# -*- coding: utf-8 -*-
"""批1收尾：dashboard.tsx 30 处 primary() 双参补英文 + 修正 CHART-01 过时文案。幂等。"""
import io

def apply(path, subs):
    s = io.open(path, encoding='utf-8').read()
    done = 0
    for old, new in subs:
        if new in s:
            done += 1
            continue
        n = s.count(old)
        assert n >= 1, f'{path} missing: {old[:70]}'
        s = s.replace(old, new)
        done += n
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'{path}: {done} replacements')

apply('app/dashboard.tsx', [
    # CHART-01 文案修正：未就绪时是等待态，不是演示K线
    ("primary('MT4 只读报价 · 当前周期历史正在准备，未就绪前明确显示演示K线', 'MT4読取専用レート・現在の時間足履歴を準備中。未準備時はデモ足を明示')",
     "primary('MT4 只读报价 · 当前周期历史正在准备，未就绪前图表保持等待态，不显示演示K线', 'MT4読取専用レート・現在の時間足履歴を準備中。未準備時はチャートを待機状態にし、デモ足は表示しません', 'MT4 read-only quotes · history for this timeframe is preparing; until ready the chart stays in a waiting state and shows no demo candles')"),
    ("primary('MT4 历史时间尚未通过校准；为避免旧K线被误读为实时，暂不用于图表或回测。', 'MT4履歴時刻が未補正のため、古い足をリアルタイムと誤認しないようチャート・検証には使用しません。')",
     "primary('MT4 历史时间尚未通过校准；为避免旧K线被误读为实时，暂不用于图表或回测。', 'MT4履歴時刻が未補正のため、古い足をリアルタイムと誤認しないようチャート・検証には使用しません。', 'MT4 history clock is not calibrated yet; to avoid reading old candles as live, it is not used for charts or backtests.')"),
    ("primary('演示报价 · 本地时间', 'デモレート・ローカル時刻')",
     "primary('演示报价 · 本地时间', 'デモレート・ローカル時刻', 'Demo quotes · local time')"),
    ("primary('显示时区', '表示時刻')",
     "primary('显示时区', '表示時刻', 'Display time zone')"),
    ("primary('选择显示时区', '表示タイムゾーンを選択')",
     "primary('选择显示时区', '表示タイムゾーンを選択', 'Select display time zone')"),
    ("primary('主要导航', 'メインナビゲーション')",
     "primary('主要导航', 'メインナビゲーション', 'Primary navigation')"),
    ("primary('总览', '概要')",
     "primary('总览', '概要', 'Overview')"),
    ("primary('货币对报价', '通貨ペアレート')",
     "primary('货币对报价', '通貨ペアレート', 'Pair quotes')"),
    ("primary('选择其他货币对', '他の通貨ペアを選択')",
     "primary('选择其他货币对', '他の通貨ペアを選択', 'Choose another pair')"),
    ("primary('时间周期', '時間足')",
     "primary('时间周期', '時間足', 'Timeframe')"),
    ("primary('更多周期', 'その他の時間足')",
     "primary('更多周期', 'その他の時間足', 'More timeframes')"),
    ("primary('日', '日足')",
     "primary('日', '日足', 'Daily')"),
    ("primary('周', '週足')",
     "primary('周', '週足', 'Weekly')"),
    ("primary('月', '月足')",
     "primary('月', '月足', 'Monthly')"),
    ("primary('年', '年足')",
     "primary('年', '年足', 'Yearly')"),
    ("primary('风险设置', 'リスク設定')",
     "primary('风险设置', 'リスク設定', 'Risk settings')"),
    ("primary('关闭设置', '設定を閉じる')",
     "primary('关闭设置', '設定を閉じる', 'Close settings')"),
    ("primary('关闭', '閉じる')",
     "primary('关闭', '閉じる', 'Close')"),
    ("primary('演示阶段', 'デモ段階')",
     "primary('演示阶段', 'デモ段階', 'Demo stage')"),
    ("primary('设置仅保存在这台设备，不会触发任何订单。', '設定はこの端末にのみ保存され、注文は送信されません。')",
     "primary('设置仅保存在这台设备，不会触发任何订单。', '設定はこの端末にのみ保存され、注文は送信されません。', 'Settings are saved on this device only and never trigger orders.')"),
    ("primary('单笔风险', '1取引リスク')",
     "primary('单笔风险', '1取引リスク', 'Risk per trade')"),
    ("primary('单日亏损上限', '日次損失上限')",
     "primary('单日亏损上限', '日次損失上限', 'Daily loss cap')"),
    ("primary('最大同时持仓', '最大同時保有数')",
     "primary('最大同时持仓', '最大同時保有数', 'Max open positions')"),
    ("primary('最大点差', '最大スプレッド')",
     "primary('最大点差', '最大スプレッド', 'Max spread')"),
    ("primary('事件暂停时间', 'イベント停止時間')",
     "primary('事件暂停时间', 'イベント停止時間', 'Event pause')"),
    ("primary('止损为强制规则', 'ストップロス必須')",
     "primary('止损为强制规则', 'ストップロス必須', 'Stop loss is mandatory')"),
    ("primary('真实交易中不能关闭', '実取引では無効化できません')",
     "primary('真实交易中不能关闭', '実取引では無効化できません', 'Cannot be disabled in live trading')"),
    ("primary('已保存', '保存しました')",
     "primary('已保存', '保存しました', 'Saved')"),
    ("primary('保存到本机', '端末に保存')",
     "primary('保存到本机', '端末に保存', 'Save locally')"),
])
