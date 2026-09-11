<#
  Enkei release packager.
  Builds a clean MIT-licensed distributable zip from the project root.
  It ships only public runtime source; never user models, AI/panel logs,
  SQLite, MT4 pairing codes, account data, API keys or private config.

  Output: <EnkeiRoot>\release\enkei-v<version>.zip
#>
[CmdletBinding()]
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$Version = '',
  [switch]$Update
)
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Version)) {
  $pkg = Get-Content (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $Version = $pkg.version
}

$ReleaseRoot = Join-Path (Split-Path -Parent $Root) 'release'
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
$PackageName = if ($Update) { "enkei-update-v$Version" } else { "enkei-v$Version" }
$ZipPath = Join-Path $ReleaseRoot "$PackageName.zip"
$Stage = Join-Path $ReleaseRoot "${PackageName}_stage"
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }

# --- Copy whitelisted files/dirs, pruning local-only state ---------------
$RootDirItems = @(
  'app', 'public', 'lib', 'bridge', 'launcher', 'installer', 'librechat', 'dist',
  'ai-terminal', 'decision-service', 'docs',
  'package.json', 'package-lock.json', 'README.md', 'README.en.md', 'LICENSE',
  'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'eslint.config.mjs',
  'next.config.ts', 'vite.config.ts', 'tsconfig.json', 'next-env.d.ts',
  'Start-Enkei.cmd', 'Update-Enkei.cmd'
)

# Sub-tree prunes (relative to the copied top-level item).
$PruneRelative = @(
  'ai-terminal/.mimosa',
  'ai-terminal/.venv',
  'ai-terminal/data',
  'ai-terminal/temp_terminal_err.log',
  'ai-terminal/temp_terminal_out.log',
  'ai-terminal/app/__pycache__',
  'decision-service/.venv',
  'decision-service/data',
  'decision-service/research/output',
  'decision-service/research/__pycache__',
  'decision-service/__pycache__',
  'decision-service/vendor/tradingagents/tradingagents.egg-info',
  'decision-service/vendor/tradingagents/__pycache__',
  'docs/CI_最近运行结果.json',
  'docs/assess_m5.json',
  'docs/稳健性复核数据_20260906.json',
  'docs/策略扫描数据_20260906.json'
)

function Copy-Clean([string]$Source, [string]$Dest) {
  if (Test-Path -LiteralPath $Source -PathType Container) {
    # Do not copy multi-hundred-MB local environments merely to delete them
    # afterwards. This keeps preview packaging bounded and prevents local
    # runtime state from ever entering the staging tree.
    & robocopy $Source $Dest /E /XD '.venv' '__pycache__' '.mimosa' '.git' '.agents' '.codex' 'node_modules' /XF '*.pyc' | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Failed to copy $Source (robocopy exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
    return
  }
  Copy-Item -LiteralPath $Source -Destination $Dest -Force
}

foreach ($item in $RootDirItems) {
  $src = Join-Path $Root $item
  if (Test-Path -LiteralPath $src) { Copy-Clean $src (Join-Path $Stage $item) }
}

foreach ($rel in $PruneRelative) {
  $p = Join-Path $Stage $rel
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}

# Remove any __pycache__ / *.pyc left anywhere in the staged tree.
Get-ChildItem -LiteralPath $Stage -Directory -Recurse -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
Get-ChildItem -LiteralPath $Stage -File -Recurse -Filter '*.pyc' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
Get-ChildItem -LiteralPath $Stage -File -Recurse -Filter '*.egg-info' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
# Agent/editor session state may contain local paths or source snapshots.  It
# is never a product runtime dependency and must not enter a public archive.
Get-ChildItem -LiteralPath $Stage -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('.mimosa', '.codex', '.agents', '.claude', '.git') } |
  Sort-Object { $_.FullName.Length } -Descending |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

# Fail the build before compression when a required first-run component is
# absent or local/private state escaped the whitelist.  This turns the manual
# release inspection into a repeatable packaging gate.
$RequiredReleaseFiles = @(
  'installer\Setup-Enkei.ps1',
  'installer\Update-Enkei.ps1',
  'installer\Install-EnkeiMt4.ps1',
  'launcher\local-launcher.mjs',
  'launcher\runtime-controller.mjs',
  'launcher\librechat-runtime.mjs',
  'librechat\compose.yml',
  'librechat\librechat.yaml',
  'librechat\.env.example',
  'bridge\EnkeiQuotePublisher.mq4',
  'bridge\EnkeiDemoExecutionGate.mq4',
  'bridge\EnkeiLiveExecutionGate.mq4',
  'docs\index.md',
  'dist\server',
  'Start-Enkei.cmd'
)
$missingReleaseFiles = @($RequiredReleaseFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Stage $_)) })
if ($missingReleaseFiles.Count -gt 0) { throw "Release package is missing required files: $($missingReleaseFiles -join ', ')" }
$forbiddenReleaseItems = @(Get-ChildItem -LiteralPath $Stage -Force -Recurse -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -in @('.env', 'gateway.json', 'terminal.log', '.enkei-runtime.json', 'pairing-session.json', 'live-enablement.json') -or
  $_.Name -like '*-runtime.log' -or $_.Extension -eq '.pyc' -or
  ($_.PSIsContainer -and $_.Name -in @('.mimosa', '.codex', '.agents', '.claude', '.git', '.venv', '__pycache__'))
})
if ($forbiddenReleaseItems.Count -gt 0) {
  $relativeForbidden = @($forbiddenReleaseItems | ForEach-Object { $_.FullName.Substring($Stage.Length + 1) })
  throw "Release package contains forbidden local/private state: $($relativeForbidden -join ', ')"
}
Write-Host "Release gate passed: required runtime files present; no forbidden local/private state found."

# --- Compress -------------------------------------------------------------
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $ZipPath -CompressionLevel Optimal
$bytes = (Get-Item -LiteralPath $ZipPath).Length
$fileCount = (Get-ChildItem -LiteralPath $Stage -Recurse -File).Count
Remove-Item -LiteralPath $Stage -Recurse -Force

Write-Host "Created $ZipPath"
Write-Host ("Size: {0:N1} MB  Files: {1}" -f ($bytes / 1MB), $fileCount)
