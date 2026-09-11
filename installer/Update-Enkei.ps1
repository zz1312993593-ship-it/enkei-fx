[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetRoot,
  [switch]$NoLaunch,
  [switch]$WhatIf
)

# Run this script from an extracted Enkei update package. It overlays public
# runtime files onto an existing installation and never copies or deletes user
# state, credentials, models, conversations, reports, ledgers, logs or MT4 data.
$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent $PSScriptRoot
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)
if (-not (Test-Path -LiteralPath (Join-Path $TargetRoot 'package.json'))) {
  throw "TargetRoot is not an Enkei installation: $TargetRoot"
}
if ($TargetRoot -eq [System.IO.Path]::GetPathRoot($TargetRoot)) {
  throw 'Refusing to update a drive root.'
}

$publicItems = @(
  'app', 'public', 'lib', 'bridge', 'launcher', 'installer', 'librechat',
  'ai-terminal', 'decision-service', 'docs', 'dist', '.openai',
  'package.json', 'package-lock.json', 'README.md', 'README.en.md', 'LICENSE',
  'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
  'eslint.config.mjs', 'next.config.ts', 'vite.config.ts', 'tsconfig.json',
  'next-env.d.ts', 'Start-Enkei.cmd', 'Update-Enkei.cmd'
)
$excludedDirs = @('.git', '.agents', '.codex', '.mimosa', '.venv', 'node_modules', '__pycache__', 'data', 'output')
$excludedFiles = @('.env', '*.pyc', '*.log', '*private*', '*credential*', '*secret*')

Write-Host "Updating Enkei in place: $TargetRoot"
Write-Host 'User data and private configuration will be preserved.'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $TargetRoot "updates\backups\$stamp"
$programBackup = Join-Path $backupRoot 'program'
$dataBackup = Join-Path $backupRoot 'user-data'
$userDataItems = @('ai-terminal\data', 'decision-service\data', 'data')

if ($WhatIf) {
  Write-Host "[PLAN] backup program and user data to $backupRoot"
  foreach ($item in $publicItems) { if (Test-Path -LiteralPath (Join-Path $SourceRoot $item)) { Write-Host "[PLAN] update $item" } }
  return
}

New-Item -ItemType Directory -Force -Path $programBackup, $dataBackup | Out-Null
foreach ($item in $publicItems) {
  $existing = Join-Path $TargetRoot $item
  if (-not (Test-Path -LiteralPath $existing)) { continue }
  $saved = Join-Path $programBackup $item
  if (Test-Path -LiteralPath $existing -PathType Container) {
    New-Item -ItemType Directory -Force -Path $saved | Out-Null
    & robocopy $existing $saved /E /R:2 /W:1 /XD $excludedDirs /XF $excludedFiles | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Program backup failed for $item (robocopy $LASTEXITCODE)" }
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
    Copy-Item -LiteralPath $existing -Destination $saved -Force
  }
}
foreach ($item in $userDataItems) {
  $existing = Join-Path $TargetRoot $item
  if (-not (Test-Path -LiteralPath $existing)) { continue }
  $saved = Join-Path $dataBackup $item
  New-Item -ItemType Directory -Force -Path $saved | Out-Null
  & robocopy $existing $saved /E /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "User data backup failed for $item (robocopy $LASTEXITCODE)" }
}
$beforeVersion = (Get-Content -Raw -LiteralPath (Join-Path $TargetRoot 'package.json') | ConvertFrom-Json).version
$targetVersion = (Get-Content -Raw -LiteralPath (Join-Path $SourceRoot 'package.json') | ConvertFrom-Json).version
@{ schema = 'enkei-update-backup/v1'; created_at = (Get-Date).ToUniversalTime().ToString('o'); from_version = $beforeVersion; to_version = $targetVersion; status = 'backup-complete' } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupRoot 'manifest.json') -Encoding UTF8

try {
  foreach ($item in $publicItems) {
    $source = Join-Path $SourceRoot $item
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $destination = Join-Path $TargetRoot $item
    if (Test-Path -LiteralPath $source -PathType Container) {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      & robocopy $source $destination /E /R:2 /W:1 /XD $excludedDirs /XF $excludedFiles | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "Update copy failed for $item (robocopy $LASTEXITCODE)" }
    } else {
      Copy-Item -LiteralPath $source -Destination $destination -Force
    }
  }
  $setup = Join-Path $TargetRoot 'installer\Setup-Enkei.ps1'
  & PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File $setup -NoLaunch
  if ($LASTEXITCODE -ne 0) { throw "Runtime migration failed (exit $LASTEXITCODE)" }
  @{ schema = 'enkei-update-backup/v1'; created_at = (Get-Date).ToUniversalTime().ToString('o'); from_version = $beforeVersion; to_version = $targetVersion; status = 'update-complete' } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupRoot 'manifest.json') -Encoding UTF8
  if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $TargetRoot 'Start-Enkei.cmd') -WorkingDirectory $TargetRoot -WindowStyle Hidden }
} catch {
  Write-Warning "Update failed; restoring program files from $programBackup"
  foreach ($item in $publicItems) {
    $saved = Join-Path $programBackup $item
    if (-not (Test-Path -LiteralPath $saved)) { continue }
    $destination = Join-Path $TargetRoot $item
    if (Test-Path -LiteralPath $saved -PathType Container) {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      & robocopy $saved $destination /E /R:2 /W:1 | Out-Null
    } else { Copy-Item -LiteralPath $saved -Destination $destination -Force }
  }
  @{ schema = 'enkei-update-backup/v1'; created_at = (Get-Date).ToUniversalTime().ToString('o'); from_version = $beforeVersion; to_version = $targetVersion; status = 'rolled-back'; error = $_.Exception.Message } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupRoot 'manifest.json') -Encoding UTF8
  throw
}
Write-Host 'Enkei update completed; user data was preserved.'
