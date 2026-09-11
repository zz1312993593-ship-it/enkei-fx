[CmdletBinding()]
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$TerminalDataRoot = (Join-Path $env:APPDATA 'MetaQuotes\Terminal'),
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$StateRoot = Join-Path $Root '.enkei-setup'
$ReportPath = Join-Path $StateRoot $(if ($WhatIf) { 'mt4-install-plan.json' } else { 'mt4-install-report.json' })
$Sources = @(
  @{ Name = 'EnkeiQuotePublisher'; File = 'EnkeiQuotePublisher.mq4'; Role = 'read-only-market-data'; Default = 'safe' },
  @{ Name = 'EnkeiDemoExecutionGate'; File = 'EnkeiDemoExecutionGate.mq4'; Role = 'demo-execution'; Default = 'disabled' },
  @{ Name = 'EnkeiLiveExecutionGate'; File = 'EnkeiLiveExecutionGate.mq4'; Role = 'live-execution'; Default = 'disabled' }
)
$Results = [System.Collections.Generic.List[object]]::new()
$StartedAt = (Get-Date).ToUniversalTime()

function Save-Mt4Report([string]$Status, [string]$Code, [string]$Message) {
  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
  [ordered]@{
    version = '1.0.0'
    status = $Status
    code = $Code
    message = $Message
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
    safety = [ordered]@{
      accounts_read = $false
      credentials_read = $false
      charts_modified = $false
      auto_trading_changed = $false
      live_ea_default = 'disabled'
    }
    terminals = @($Results)
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

try {
  foreach ($source in $Sources) {
    $sourcePath = Join-Path (Join-Path $Root 'bridge') $source.File
    if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Missing bundled MT4 source: $($source.File)" }
  }

  $terminalDirs = @()
  if (Test-Path -LiteralPath $TerminalDataRoot) {
    $terminalDirs = @(Get-ChildItem -LiteralPath $TerminalDataRoot -Directory -ErrorAction Stop | Where-Object {
      $_.Name -notin @('Common', 'Community', 'Help') -and
      (Test-Path -LiteralPath (Join-Path $_.FullName 'MQL4')) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName 'origin.txt'))
    })
  }
  if ($terminalDirs.Count -eq 0) {
    Save-Mt4Report 'not-installed' 'E217' 'No MT4 terminal data directory was found. Install the broker MT4 terminal once, then rerun Enkei setup.'
    Write-Host '[WARN] No MT4 terminal was found. Enkei itself remains installed.'
    exit 0
  }

  $backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($terminal in $terminalDirs) {
    $origin = (Get-Content -Raw -LiteralPath (Join-Path $terminal.FullName 'origin.txt')).Trim()
    $metaEditor = @(
      (Join-Path $origin 'metaeditor.exe'),
      (Join-Path $origin 'metaeditor64.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $targetDir = Join-Path $terminal.FullName 'MQL4\Experts'
    $terminalResult = [ordered]@{
      terminal_id = $terminal.Name
      broker_installation = $origin
      data_directory = $terminal.FullName
      status = if ($WhatIf) { 'planned' } else { 'installing' }
      compiler = $metaEditor
      files = @()
      user_action = 'Open MT4 Navigator, refresh Expert Advisors, then attach only the required EA. Live execution remains disabled by default.'
    }
    if (-not $metaEditor) {
      $terminalResult.status = 'compiler-missing'
      $Results.Add($terminalResult)
      continue
    }

    if (-not $WhatIf) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
    $fileResults = [System.Collections.Generic.List[object]]::new()
    foreach ($source in $Sources) {
      $sourcePath = Join-Path (Join-Path $Root 'bridge') $source.File
      $targetPath = Join-Path $targetDir $source.File
      $compiledPath = [System.IO.Path]::ChangeExtension($targetPath, '.ex4')
      $backupPath = $null
      if ((Test-Path -LiteralPath $targetPath) -and -not $WhatIf) {
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
        if ($sourceHash -ne $targetHash) {
          $backupDir = Join-Path (Join-Path (Join-Path $StateRoot 'mt4-backups') $backupStamp) $terminal.Name
          New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
          $backupPath = Join-Path $backupDir $source.File
          Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force
          if (Test-Path -LiteralPath $compiledPath) { Copy-Item -LiteralPath $compiledPath -Destination (Join-Path $backupDir ([System.IO.Path]::GetFileName($compiledPath))) -Force }
        }
      }
      if ($WhatIf) {
        $fileResults.Add([ordered]@{ file = $source.File; role = $source.Role; default = $source.Default; status = 'planned'; backup = $backupPath })
        continue
      }
      Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
      $compileLog = Join-Path $StateRoot ("mt4-compile-{0}-{1}.log" -f $terminal.Name, $source.Name)
      $compileStarted = Get-Date
      $process = Start-Process -FilePath $metaEditor -ArgumentList @("/compile:$targetPath", "/log:$compileLog") -Wait -PassThru -WindowStyle Hidden
      $compiled = Test-Path -LiteralPath $compiledPath
      $fresh = $compiled -and ((Get-Item -LiteralPath $compiledPath).LastWriteTime -ge $compileStarted.AddSeconds(-3))
      # Rakuten MetaEditor returns process code 1 even when its compiler log
      # says 0 errors.  The authoritative result is the compiler summary plus
      # a freshly emitted EX4, not the launcher process exit code.
      $compileOutput = if (Test-Path -LiteralPath $compileLog) { Get-Content -Raw -LiteralPath $compileLog -ErrorAction SilentlyContinue } else { '' }
      $zeroErrors = $compileOutput -match 'Result:\s*0 errors'
      $warningMatch = [regex]::Match($compileOutput, 'Result:\s*0 errors,\s*(\d+) warnings?')
      $warningCount = if ($warningMatch.Success) { [int]$warningMatch.Groups[1].Value } else { $null }
      # Some broker-customised MetaEditor builds (including Rakuten MT4)
      # return exit code 1 and ignore /log even after emitting a fresh, valid
      # EX4. A newly written EX4 is therefore authoritative when no compiler
      # log exists; when a log exists it must still report zero errors.
      $status = if ($fresh -and ($zeroErrors -or [string]::IsNullOrWhiteSpace($compileOutput))) { 'compiled' } else { 'compile-failed' }
      $fileResults.Add([ordered]@{
        file = $source.File
        role = $source.Role
        default = $source.Default
        status = $status
        source_sha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
        installed_sha256 = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
        compiled_file = if ($compiled) { $compiledPath } else { $null }
        compiler_exit = $process.ExitCode
        compiler_errors = if ($zeroErrors -or ($fresh -and [string]::IsNullOrWhiteSpace($compileOutput))) { 0 } else { $null }
        compiler_warnings = $warningCount
        compile_log = $compileLog
        backup = $backupPath
      })
    }
    $terminalResult.files = @($fileResults)
    $terminalResult.status = if ($WhatIf) { 'planned' } elseif (@($fileResults | Where-Object { $_.status -ne 'compiled' }).Count -eq 0) { 'installed' } else { 'failed' }
    $Results.Add($terminalResult)
  }

  $failed = @($Results | Where-Object { $_.status -in @('compiler-missing', 'failed') }).Count
  if ($failed -gt 0) {
    Save-Mt4Report 'failed' 'E218' "$failed MT4 installation(s) could not compile all Enkei EAs."
    exit 1
  }
  $status = if ($WhatIf) { 'planned' } else { 'passed' }
  Save-Mt4Report $status 'E000' "Enkei MT4 EA installation $status for $($Results.Count) terminal(s)."
  Write-Host "[OK] MT4 EA installation $status for $($Results.Count) terminal(s)."
  exit 0
} catch {
  Save-Mt4Report 'failed' 'E218' $_.Exception.Message
  Write-Host "[ERROR] $($_.Exception.Message)"
  exit 1
}
