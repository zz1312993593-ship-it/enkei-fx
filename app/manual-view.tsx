'use client';

// 批J：三语使用说明（跟随界面语言）。覆盖 准备/数据/研究/Demo/模型/运维/免责 七节。
type Language = 'zh' | 'ja' | 'en';

export default function ManualView({ language }: { language: Language }) {
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const sections: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: t('1. 准备与启动', '1. 準備と起動', '1. Setup & startup'),
      rows: [
        [t('统一启动', '統一起動', 'One launcher'), t('双击“Start-Enkei.cmd”：首次运行自动安装环境，之后直接打开 127.0.0.1:3000。', '「Start-Enkei.cmd」を実行：初回は環境を自動導入し、次回以降は 127.0.0.1:3000 を直接開きます。', 'Run Start-Enkei.cmd: the first launch installs the runtime automatically; later launches open 127.0.0.1:3000 directly.')],
        [t('MT4 桥', 'MT4ブリッジ', 'MT4 bridge'), t('把 bridge/EnkeiQuotePublisher.mq4 放入 MT4 Experts 编译并挂到图表；它是只读的，不含下单代码。', 'bridge/EnkeiQuotePublisher.mq4 を Experts に入れてコンパイル・装着。読み取り専用で注文関数はありません。', 'Drop bridge/EnkeiQuotePublisher.mq4 into Experts, compile and attach; it is read-only with no order code.')],
      ],
    },
    {
      title: t('2. 行情与数据', '2. レートとデータ', '2. Market data'),
      rows: [
        [t('等待态', '待機状態', 'Waiting state'), t('时钟未校准或历史过期时，图表显示等待而不出图——这是刻意设计，防止把旧数据当实时。', '時刻未補正や履歴期限切れではチャートは待機表示。旧データを実データ扱いにしないための設計です。', 'With an uncalibrated clock or stale history the chart waits on purpose — old data is never shown as live.')],
        [t('数据质量页', 'データ品質ページ', 'Data quality page'), t('市场 → 数据质量 查看报价新鲜度、时钟校准、周期覆盖与缺口数。', '市場→データ品質で鮮度・時刻補正・時間足カバー・欠損数を確認。', 'Markets → Data quality shows freshness, clock calibration, coverage and gaps.')],
        [t('周末/休市', '週末・休市', 'Weekends'), t('休市时报价快照可能停留在周五收盘，历史不新增；系统会标注而不是伪装实时。', '休市中はレートが金曜終値のままになることがあります。システムは実況と偽りません。', 'On weekends the snapshot may stay at Friday close; the system labels this instead of pretending it is live.')],
      ],
    },
    {
      title: t('3. 研究流程', '3. 研究フロー', '3. Research workflow'),
      rows: [
        [t('顺序', '順序', 'Order'), t('回测 → 策略筛选（样本外）→ 前向验证 → 内部模拟；每一步都有明确门槛，不满足就不进入下一步。', '検証→選抜（サンプル外）→フォワード検証→内部ペーパー。各段階に明確なゲートがあります。', 'Backtest → out-of-sample selection → forward validation → internal paper; each step has explicit gates.')],
        [t('成本', 'コスト', 'Costs'), t('回测计入点差与滑点；同一根K线上止损优先于止盈（保守处理）。', '検証にはスプレッドとスリッページを計上。同一足はストップ優先（保守的）。', 'Spreads and slippage are charged; same-bar stops are conservatively preferred.')],
        [t('蒙特卡洛', 'モンテカルロ', 'Monte Carlo'), t('回测页可展开 MC 重抽样（固定随机种子，可复现），看坏运气叠加下的回撤分布——它不是收益承诺。', '検証ページのMC再サンプリング（固定シードで再現可能）は、不運重なりのDD分布を見るものです。', 'The MC panel resamples the same trades with a fixed seed; it shows drawdown luck, not promises.')],
      ],
    },
    {
      title: t('4. Demo 演练（受控）', '4. Demo 演習（制御付き）', '4. Controlled Demo'),
      rows: [
        [t('三道控制', '三重の制御', 'Three controls'), t('配对码验证 + 确认词 + 随时急停；网页只创建 90 秒有效的指令，成交以 MT4 为准。', 'ペアリング検証＋確認語＋緊急停止。Webは90秒有効の指示を作るだけで、約定はMT4基準。', 'Pairing + confirmation phrase + emergency stop; the web page only creates 90-second intents and MT4 is the single source of fills.')],
        [t('急停', '緊急停止', 'Emergency stop'), t('人工急停永远不会被程序自动解除；恢复需要你手动操作。', '手動緊急停止が自動解除されることはありません。復旧は必ず手動です。', 'A manual emergency stop is never auto-released; recovery is always manual.')],
        [t('实盘', '実取引', 'Live'), t('实盘默认全局锁定；启用需要账户号+确认词+手动挂载 EA，且日亏上限与急停始终生效。', '実取引は既定ロック。口座番号＋確認語＋EA手動装着が必要で、日次損失上限と緊急停止は常時有効。', 'Live is locked by default; enabling needs account number + phrase + a manually attached EA, with the daily cap and kill switch always active.')],
      ],
    },
    {
      title: t('5. 模型与连接', '5. モデルと接続', '5. Models & links'),
      rows: [
        [t('统一分析体', '統合分析体', 'Unified analysis entity'), t('在 模型与连接 → AI 终端 配置路由；密钥只写本机私有配置，界面永不回显原文。', 'モデルと接続→AIターミナルで経路を設定。キーは端末内の非公開設定のみ。', 'Configure routes under Models & links → AI terminal; keys stay in local private config and are never echoed.')],
        [t('失败行为', '失敗時の挙動', 'Failure behaviour'), t('外部调用失败自动退避重试；连续失败会熔断暂停，避免刷接口。判断失败时回退为 wait。', '外部呼出は指数退避で再試行。連続失敗でサーキットブレーカが作動。判断失敗時は wait に復帰。', 'Calls retry with backoff; repeated failures trip the breaker. Failed judgements fall back to wait.')],
        [t('新闻', 'ニュース', 'News'), t('新闻来自可替换的 RSS 源，带来源与时间；界面语言为中文/日文时会用统一分析体翻译标题（需已配置模型）。', 'ニュースは差し替え可能なRSS。出典と時刻付き。中/日表示では統合分析体が翻訳します（設定済みの場合）。', 'News comes from replaceable RSS with sources and timestamps; titles are machine-translated for zh/ja when a model route is configured.')],
      ],
    },
    {
      title: t('6. 运维与排障', '6. 運用とトラブルシュート', '6. Operations & troubleshooting'),
      rows: [
        [t('健康检查', 'ヘルスチェック', 'Health checks'), t('运营中心每 15 秒自动体检：行情桥、历史时钟、后台研究、Demo 服务、启动自检。', '運用センターが15秒ごとに点検：レート・履歴時刻・研究・Demo・起動セルフチェック。', 'The operations centre self-checks every 15s: bridge, clock, research, demo service, startup self-check.')],
        [t('错误代码', 'エラーコード', 'Error codes'), t('运营中心“查看内置说明与错误代码”提供全部 E-codes 的原因与处理方法（跟随界面语言）。', '運用センターのガイドで全Eコードの原因と対処を確認できます（表示言語に追従）。', 'The in-app guide lists every E-code with cause and fix (in your UI language).')],
        [t('诊断包', '診断パッケージ', 'Diagnostics bundle'), t('“一键诊断包”导出脱敏状态与建议；不含账户、配对码或密钥，可直接发给技术支持。', 'ワンクリック診断はマスク済み。口座・ペアリング・キーを含まず、そのまま添付できます。', 'The diagnostics bundle exports masked status and guidance — no accounts, pairing codes or keys — ready to attach.')],
      ],
    },
    {
      title: t('7. 风险与免责', '7. リスクと免責', '7. Risk & disclaimer'),
      rows: [
        [t('性质', '性質', 'Nature'), t('本软件是研究工具，不构成投资建议；模型输出可能有错，置信度不是概率保证。', '本ソフトは研究ツールであり投資助言ではありません。モデル出力は誤り得ます。', 'This is a research tool, not investment advice; model output can be wrong and confidence is not a probability guarantee.')],
        [t('数据', 'データ', 'Data'), t('行情与历史归你的券商所有，不得对外再分发；新闻展示保留出处。', 'レート・履歴は券商に帰属し再配布禁止。ニュースは出典を表示。', 'Market data belongs to your broker — do not redistribute; news keeps its source attribution.')],
      ],
    },
  ];
  return (
    <div className="manual-view">
      <p className="eyebrow">USER MANUAL</p>
      <h2>{t('使用说明', '取扱説明', 'User manual')}</h2>
      <small>{t('本页跟随界面语言；更多细节见仓库 docs/ 与 README。', 'このページは表示言語に追従します。詳細はリポジトリの docs/ と README を参照。', 'This page follows your UI language; see docs/ and README in the repository for more.')}</small>
      {sections.map((section) => (
        <section key={section.title} className="manual-section">
          <h3>{section.title}</h3>
          {section.rows.map(([label, body]) => (
            <article key={label}><strong>{label}</strong><span>{body}</span></article>
          ))}
        </section>
      ))}
    </div>
  );
}
