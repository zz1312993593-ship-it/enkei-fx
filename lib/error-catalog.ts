// 批I：错误码三语知识库（原因 + 解决方法，跟随界面语言显示）。
// owner: 'user' = 用户可自行处理；'support' = 需附带诊断包联系技术支持。
// 来源：launcher/local-launcher.mjs、launcher/runtime-controller.mjs、installer/Setup-Enkei.ps1。
export interface ErrorCatalogEntry {
  code: string;
  stage: 'startup' | 'install' | 'runtime' | 'demo';
  title: { zh: string; ja: string; en: string };
  cause: { zh: string; ja: string; en: string };
  fix: { zh: string; ja: string; en: string };
  owner: 'user' | 'support';
}

export const ERROR_CATALOG: ErrorCatalogEntry[] = [
  {
    code: 'E000', stage: 'runtime',
    title: { zh: '运行信息（非错误）', ja: '実行情報（エラーではありません）', en: 'Runtime info (not an error)' },
    cause: { zh: '服务启动、日志轮转、网关更新等正常事件记录。', ja: 'サービス起動・ログローテーション・ゲート更新などの正常記録。', en: 'Normal events: service starts, log rotation, gate upgrades.' },
    fix: { zh: '无需处理。', ja: '対応不要です。', en: 'No action needed.' },
    owner: 'user',
  },
  {
    code: 'E010', stage: 'startup',
    title: { zh: '本地启动器已运行', ja: 'ローカル起動ツールが実行中', en: 'Local launcher started' },
    cause: { zh: '启动器正常启动的信息记录。', ja: '起動ツールが正常に開始した記録。', en: 'Informational: launcher boot record.' },
    fix: { zh: '无需处理。', ja: '対応不要です。', en: 'No action needed.' },
    owner: 'user',
  },
  {
    code: 'E110', stage: 'startup',
    title: { zh: '正在准备本地运行组件', ja: 'ローカル実行コンポーネントを準備中', en: 'Preparing local runtime components' },
    cause: { zh: '首次运行需要创建运行环境，可能需要几分钟。', ja: '初回は実行環境の作成に数分かかることがあります。', en: 'First run creates the runtime; this can take a few minutes.' },
    fix: { zh: '耐心等待，不要关闭窗口。', ja: 'ウィンドウを閉じずにお待ちください。', en: 'Wait; do not close the window.' },
    owner: 'user',
  },
  {
    code: 'E111', stage: 'startup',
    title: { zh: '本地组件准备失败', ja: 'ローカルコンポーネントの準備に失敗', en: 'Failed to prepare local components' },
    cause: { zh: '依赖安装命令以非零退出码结束，通常是网络中断或代理拦截。', ja: '依存インストールが異常終了。多くはネットワーク切断やプロキシ阻害です。', en: 'Dependency install exited non-zero; usually a network drop or proxy interference.' },
    fix: { zh: '检查网络（含代理/防火墙）后重新运行“Start-Enkei.cmd”。', ja: 'ネットワーク（プロキシ・ファイアウォール含む）を確認し、「Start-Enkei.cmd」を再実行。', en: 'Check network (proxy/firewall) and run Start-Enkei.cmd again.' },
    owner: 'user',
  },
  {
    code: 'E121', stage: 'startup',
    title: { zh: '启动自检未通过', ja: '起動セルフチェック未合格', en: 'Startup self-check failed' },
    cause: { zh: '启动组件完整性检查未通过（文件缺失或版本不匹配）。', ja: '起動コンポーネントの整合性確認に失敗（欠損・不一致）。', en: 'Component integrity check failed (missing files or version mismatch).' },
    fix: { zh: '在运营中心重新运行健康检查；若仍失败，重新运行“Start-Enkei.cmd”。', ja: '運用センターでヘルスチェックを再実行。改善しなければ「Start-Enkei.cmd」を再実行。', en: 'Re-run health checks in the Operations centre; if it persists, run Start-Enkei.cmd again.' },
    owner: 'user',
  },
  {
    code: 'E122', stage: 'startup',
    title: { zh: '旧版启动锁清理失败', ja: '旧パネルの起動ロック削除に失敗', en: 'Could not clear a stale panel lock' },
    cause: { zh: '旧版本面板的残留锁文件被占用。', ja: '旧バージョンの残ロックファイルが使用中。', en: 'A stale lock file from an old panel is still in use.' },
    fix: { zh: '关闭所有圆衡窗口后重新启动；启动器会继续尝试。', ja: '円衡のウィンドウをすべて閉じてから再起動。起動ツールは再試行します。', en: 'Close all Enkei windows and restart; the launcher keeps retrying.' },
    owner: 'user',
  },
  {
    code: 'E123', stage: 'startup',
    title: { zh: '面板进程无法启动', ja: 'パネルプロセスを起動できません', en: 'Panel process failed to start' },
    cause: { zh: '面板命令行启动异常，常见于端口被占用或运行时损坏。', ja: 'パネル起動コマンドが異常。ポート競合や実行環境破損が典型。', en: 'Panel launch failed; typically a port conflict or corrupted runtime.' },
    fix: { zh: '查看 enkei-panel-runtime.log 末尾；关闭占用 3000 端口的程序后重启。', ja: 'enkei-panel-runtime.log の末尾を確認。ポート3000を閉じて再起動。', en: 'Check the tail of enkei-panel-runtime.log; free port 3000 and restart.' },
    owner: 'user',
  },
  {
    code: 'E124', stage: 'runtime',
    title: { zh: '后台服务守护失败', ja: 'バックグラウンドサービスの守護に失敗', en: 'Background service watchdog failed' },
    cause: { zh: '行情桥/研究守护等只读后台服务的一次守护周期异常（通常瞬时）。', ja: 'レートブリッジ等の守護サイクルで一時的例外（多くは瞬間的）。', en: 'A watchdog cycle for read-only services threw (usually transient).' },
    fix: { zh: '一般自动恢复；若行情持续不可用，重启面板。', ja: '通常は自動復旧。レートが回復しない場合はパネルを再起動。', en: 'It recovers automatically; if quotes stay down, restart the panel.' },
    owner: 'user',
  },
  {
    code: 'E125', stage: 'runtime',
    title: { zh: 'AI 终端守护失败', ja: 'AIターミナルの守護に失敗', en: 'AI terminal watchdog failed' },
    cause: { zh: 'AI 终端自动启动或保活出现异常（端口冲突、环境损坏等）。', ja: 'AIターミナルの自動起動・ keep-alive で例外（ポート競合・環境破損など）。', en: 'Auto-start or keep-alive of the AI terminal failed (port conflict, broken env).' },
    fix: { zh: '查看 enkei-ai-terminal-runtime.log 末尾；在设置页手动停止后再启动，勿反复点击。', ja: 'enkei-ai-terminal-runtime.log を確認。設定画面で停止→起動を実行（連打しない）。', en: 'Check the AI terminal runtime log; stop then start from Settings instead of retry-spamming.' },
    owner: 'user',
  },
  {
    code: 'E130', stage: 'runtime',
    title: { zh: '决策服务未就绪', ja: '決定サービスが未準備', en: 'Decision service not ready' },
    cause: { zh: '决策服务源码不完整、venv 未安装或依赖不完整。', ja: 'ソース不完整・venv未導入・依存不完整のいずれか。', en: 'Missing sources, missing venv, or incomplete dependencies.' },
    fix: { zh: '重新运行“Start-Enkei.cmd”；若包不完整请重新下载完整分发包。', ja: '「Start-Enkei.cmd」を再実行。パッケージ不完全なら再ダウンロード。', en: 'Run Start-Enkei.cmd again; re-download the full package if files are missing.' },
    owner: 'user',
  },
  {
    code: 'E140', stage: 'startup',
    title: { zh: '面板未在时限内就绪', ja: 'パネルが制限時間内に準備できません', en: 'Panel not ready within the time limit' },
    cause: { zh: '面板启动超过 120 秒未响应（低端机首次构建、端口被占、依赖损坏）。', ja: '120秒超過で無応答（低性能機の初回構築・ポート競合・依存破損）。', en: 'No response after 120s (first build on slow machines, port conflict, broken deps).' },
    fix: { zh: '查看 enkei-panel-runtime.log 末尾 15 行；重启面板。仍失败则附诊断包联系支持。', ja: 'パネルログ末尾15行を確認し再起動。改善なければ診断パッケージを添えてサポートへ。', en: 'Check the last 15 log lines and restart; if unresolved, attach a diagnostics bundle for support.' },
    owner: 'support',
  },
  {
    code: 'E200', stage: 'install',
    title: { zh: '系统或运行时版本不符', ja: 'OS・ランタイムのバージョン不一致', en: 'OS or runtime version unsupported' },
    cause: { zh: '需要 64 位 Windows 10+；Node/Python 版本过旧或无法读取版本。', ja: '64bit Windows 10+ が必要。Node/Python が旧式かバージョン判定不可。', en: 'Requires 64-bit Windows 10+; Node/Python too old or version unreadable.' },
    fix: { zh: '升级 Node.js 22.13+ / Python 3.11+，使用 64 位 Windows。', ja: 'Node.js 22.13+ / Python 3.11+ に更新し、64bit Windows を使用。', en: 'Upgrade to Node.js 22.13+ / Python 3.11+ on 64-bit Windows.' },
    owner: 'user',
  },
  {
    code: 'E201', stage: 'install',
    title: { zh: '无法调用 winget 安装组件', ja: 'winget でコンポーネントを導入できません', en: 'Cannot install via winget' },
    cause: { zh: 'Windows App Installer（winget）缺失或被策略禁用。', ja: 'Windows App Installer（winget）が無いか、ポリシーで無効。', en: 'Windows App Installer (winget) missing or disabled by policy.' },
    fix: { zh: '在 Microsoft Store 更新“应用安装程序”后重试；或手动安装 Node/Python 后再跑配装。', ja: 'Microsoft Store で「アプリ インストーラー」を更新して再実行。手動導入でも可。', en: 'Update “App Installer” from Microsoft Store and retry, or install Node/Python manually.' },
    owner: 'user',
  },
  {
    code: 'E202', stage: 'install',
    title: { zh: '组件安装失败', ja: 'コンポーネントの導入に失敗', en: 'Component installation failed' },
    cause: { zh: 'winget 安装命令以非零退出码结束，通常是网络问题。', ja: 'winget が異常終了。多くはネットワーク要因。', en: 'winget exited non-zero; usually network-related.' },
    fix: { zh: '检查网络后重新运行配装。', ja: 'ネットワーク確認のうえ再実行。', en: 'Check network and re-run setup.' },
    owner: 'user',
  },
  {
    code: 'E203', stage: 'install',
    title: { zh: 'Node.js 不可用或版本过旧', ja: 'Node.js が利用不可・旧バージョン', en: 'Node.js missing or too old' },
    cause: { zh: '安装后未找到、无法运行，或低于 22.13。', ja: '導入後に見つからない・実行不可・22.13 未満。', en: 'Not found or not runnable after install, or below 22.13.' },
    fix: { zh: '重启 Windows 一次后重试；旧版本请先卸载。', ja: '一度 Windows を再起動して再試行。旧版はアンインストール。', en: 'Restart Windows once and retry; uninstall older versions first.' },
    owner: 'user',
  },
  {
    code: 'E204', stage: 'install',
    title: { zh: 'Python 不可用或版本过旧', ja: 'Python が利用不可・旧バージョン', en: 'Python missing or too old' },
    cause: { zh: '安装后未找到、无法运行，或低于 3.11。', ja: '導入後に見つからない・実行不可・3.11 未満。', en: 'Not found or not runnable after install, or below 3.11.' },
    fix: { zh: '重启 Windows 一次后重试；旧版本请先卸载。', ja: '一度 Windows を再起動して再試行。旧版はアンインストール。', en: 'Restart Windows once and retry; uninstall older versions first.' },
    owner: 'user',
  },
  {
    code: 'E205', stage: 'install',
    title: { zh: 'Ollama 不可用', ja: 'Ollama が利用不可', en: 'Ollama unavailable' },
    cause: { zh: '安装后未找到或无法运行（本机模型路线需要）。', ja: '導入後に見つからない・実行不可（ローカルモデルに必要）。', en: 'Not found or not runnable (needed for the local model route).' },
    fix: { zh: '重启后重试；不需要本机模型时可用 `-NoModelDownload` 轻量安装，AI 研究走云端路线。', ja: '再起動後に再試行。ローカルモデル不要なら -NoModelDownload で軽量導入も可。', en: 'Restart and retry; use the lightweight setup without the local model if you rely on cloud routes.' },
    owner: 'user',
  },
  {
    code: 'E206', stage: 'install',
    title: { zh: '分发包源码不完整', ja: '配布パッケージのソース不完全', en: 'Bundled sources incomplete' },
    cause: { zh: 'AI 终端/决策服务源文件缺失，常见于解压中断。', ja: 'ソース欠損。解凍中断が典型。', en: 'Missing source files; typically an interrupted extraction.' },
    fix: { zh: '重新下载完整分发包并重新解压。', ja: '完全パッケージを再ダウンロード・再解凍。', en: 'Re-download the full package and extract again.' },
    owner: 'support',
  },
  {
    code: 'E207', stage: 'install',
    title: { zh: 'Python 环境创建失败', ja: 'Python 環境の作成に失敗', en: 'Failed to create the Python environment' },
    cause: { zh: 'venv 创建异常，常见于杀毒软件拦截或路径含中文/过深。', ja: 'venv作成の異常。セキュリティソフト阻害や深い・日本語パスが典型。', en: 'venv creation failed; often antivirus interference or a deep/non-ASCII path.' },
    fix: { zh: '把仓库放在短英文路径（如 C:\\enkei），暂时关闭实时防护后重跑配装。', ja: '短い英字パス（例 C:\\enkei）に置き、保護を一時停止して再実行。', en: 'Place the repo in a short ASCII path (e.g. C:\\enkei), pause real-time protection, re-run setup.' },
    owner: 'user',
  },
  {
    code: 'E208', stage: 'install',
    title: { zh: 'Python 包安装失败或不完整', ja: 'Python パッケージ導入の失敗・不完全', en: 'Python packages failed or incomplete' },
    cause: { zh: 'pip 安装中断或校验失败。', ja: 'pip 導入の中断・検証失敗。', en: 'pip install interrupted or verification failed.' },
    fix: { zh: '保持网络畅通重新运行配装；勿反复点击启动按钮。', ja: 'ネットワークを確保して再実行。起動ボタンを連打しない。', en: 'Re-run setup with stable network; do not spam the start button.' },
    owner: 'user',
  },
  {
    code: 'E209', stage: 'runtime',
    title: { zh: 'AI 终端未能自动启动', ja: 'AIターミナルの自動起動に失敗', en: 'AI terminal auto-start failed' },
    cause: { zh: '启动报错（依赖缺失、端口占用、源码不完整等），详情在运行日志。', ja: '起動エラー（依存欠損・ポート競合・ソース不完全など）。詳細は実行ログ。', en: 'Start error (missing deps, port conflict, incomplete sources); details in the runtime log.' },
    fix: { zh: '查看 enkei-ai-terminal-runtime.log 末尾；按日志修复后在设置页手动启动一次。', ja: '実行ログ末尾を確認し、修正後に設定画面で手動起動。', en: 'Check the runtime log, fix the cause, then start once from Settings.' },
    owner: 'user',
  },
  {
    code: 'E210', stage: 'install',
    title: { zh: '前端依赖安装失败', ja: 'フロントエンド依存の導入失敗', en: 'Frontend dependencies failed to install' },
    cause: { zh: 'npm 安装中断或 registry 不可达。', ja: 'npm 導入の中断・レジストリ到達不可。', en: 'npm install interrupted or registry unreachable.' },
    fix: { zh: '检查网络/代理后重新运行配装。', ja: 'ネットワーク・プロキシを確認し再実行。', en: 'Check network/proxy and re-run setup.' },
    owner: 'user',
  },
  {
    code: 'E211', stage: 'install',
    title: { zh: '磁盘空间不足', ja: 'ディスク容量不足', en: 'Insufficient disk space' },
    cause: { zh: '安装盘剩余空间低于要求（含模型下载需要约 12 GB）。', ja: '必要容量未満（モデル導入時は約12GB）。', en: 'Free space below the requirement (about 12 GB with model download).' },
    fix: { zh: '清理空间后重试；或使用轻量安装（不下载本地模型）。', ja: '空きを確保して再試行。軽量導入（モデル無し）も可。', en: 'Free up space and retry, or use the lightweight setup without a local model.' },
    owner: 'user',
  },
  {
    code: 'E212', stage: 'install',
    title: { zh: '生产构建验证失败', ja: '本番ビルド検証に失敗', en: 'Production build verification failed' },
    cause: { zh: '安装末尾的前端构建未通过，通常伴随依赖或源码问题。', ja: '最終ビルドが不通過。依存やソースの問題を伴うことが多い。', en: 'The final build failed; usually alongside dependency or source issues.' },
    fix: { zh: '查看安装报告中的 npm 输出；修复后重跑配装。', ja: 'レポートの npm 出力を確認し、修正後に再実行。', en: 'Inspect the npm output in the install report, fix, and re-run.' },
    owner: 'support',
  },
  {
    code: 'E299', stage: 'install',
    title: { zh: '未分类安装错误', ja: '未分類の導入エラー', en: 'Unclassified install error' },
    cause: { zh: '出现了未预期的安装异常。', ja: '想定外の異常。', en: 'An unexpected installation exception occurred.' },
    fix: { zh: '附上 .enkei-setup/first-run-report.json 与诊断包联系技术支持。', ja: 'first-run-report.json と診断パッケージを添えてサポートへ。', en: 'Contact support with first-run-report.json and a diagnostics bundle.' },
    owner: 'support',
  },
  {
    code: 'E301', stage: 'demo',
    title: { zh: 'Demo 配对未验证', ja: 'Demo ペアリング未検証', en: 'Demo pairing not verified' },
    cause: { zh: '配对码已填入但尚未通过本机确认服务验证。', ja: 'コード入力済みだが、確認サービスの検証が未完了。', en: 'The pairing code was entered but not verified against the local service.' },
    fix: { zh: '在 Demo 页点击“验证并连接”完成验证，之后才能解除急停。', ja: 'Demo画面で「検証して接続」を完了させてから緊急停止を解除。', en: 'Click “Verify & connect” on the Demo page; only then release the emergency stop.' },
    owner: 'user',
  },
  {
    code: 'E302', stage: 'demo',
    title: { zh: 'Demo 连接自动恢复中', ja: 'Demo 接続の自動復旧中', en: 'Demo link auto-recovering' },
    cause: { zh: '本机执行连接短暂中断，正在按安全策略自动恢复（人工急停不会自动解除）。', ja: '実行接続が一時切断。安全ポリシーに従い自動復旧中（手動緊急停止は解除されません）。', en: 'The execution link dropped briefly; safe auto-recovery is running (a manual stop is never auto-released).' },
    fix: { zh: '等待恢复指示；若长时间不恢复，检查 MT4 与确认服务状态。', ja: '復旧表示を待つ。長時間復旧しない場合はMT4と確認サービスを確認。', en: 'Wait for recovery; if it persists, check MT4 and the confirmation service.' },
    owner: 'user',
  },
];

export function errorCatalogByStage(stage: ErrorCatalogEntry['stage']): ErrorCatalogEntry[] {
  return ERROR_CATALOG.filter((entry) => entry.stage === stage);
}
