[CmdletBinding()]
param(
  [switch]$NoModelDownload,
  [switch]$InstallFallbackModel,
  [switch]$SkipLibreChat,
  [switch]$NoLaunch,
  [switch]$WhatIf
)

# Enkei first-run installer.  It intentionally installs only the public
# runtime dependencies; account data, MT4 files, logs and model files are
# never bundled with a release archive.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root '.enkei-setup'
$ReportPath = Join-Path $StateDir $(if ($WhatIf) { 'first-run-plan.json' } else { 'first-run-report.json' })
$DefaultModel = 'deepseek-r1:7b'
$SetupVersion = '1.0.0-beta.1-installer-r1'
$MinimumNode = [version]'22.13.0'
$MinimumPython = [version]'3.11.0'
$Steps = [System.Collections.Generic.List[object]]::new()
$script:ReportFinalized = $false

function Show-SetupProgress([int]$Percent, [string]$Activity) {
  $bounded = [Math]::Max(0, [Math]::Min(100, $Percent))
  Write-Progress -Activity 'Enkei first-run setup' -Status $Activity -PercentComplete $bounded
  Write-Host "[PROGRESS $bounded%] $Activity"
}

function Add-Step([string]$Name, [string]$Status, [string]$Detail) {
  $script:Steps.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail; at = (Get-Date).ToUniversalTime().ToString('o') })
  Write-Host "[$Status] $Name - $Detail"
}

function Save-Report([string]$Status, [string]$Code, [string]$Message) {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  [ordered]@{
    version = $SetupVersion
    status = $Status
    code = $Code
    message = $Message
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
    steps = @($Steps)
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  $script:ReportFinalized = $true
}

function Stop-Setup([string]$Code, [string]$Message) {
  Add-Step 'setup' 'FAIL' "$($Code): $Message"
  Save-Report 'failed' $Code $Message
  throw "$Code - $Message"
}

function Find-CommandPath([string]$Name, [string[]]$Candidates = @()) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in $Candidates) {
    try {
      if (Test-Path -LiteralPath $candidate -ErrorAction Stop) { return $candidate }
    } catch {
      # WindowsApps execution aliases are deliberately not readable through
      # Test-Path on some Windows installations, but remain executable by
      # their absolute path.  Preserve that known launcher path instead of
      # aborting setup with a generic Access Denied error.
      if ($candidate -like "$env:LOCALAPPDATA\Microsoft\WindowsApps\*") { return $candidate }
    }
  }
  return $null
}

function ConvertTo-Version([string]$Text, [string]$Label) {
  $match = [regex]::Match($Text, '(\d+)\.(\d+)(?:\.(\d+))?')
  if (-not $match.Success) { Stop-Setup 'E200' "Could not read the $Label version from: $Text" }
  $patch = if ($match.Groups[3].Success) { $match.Groups[3].Value } else { '0' }
  return [version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$patch)
}

function Test-SystemReadiness() {
  if (-not [Environment]::Is64BitOperatingSystem) { Stop-Setup 'E200' 'Enkei requires 64-bit Windows.' }
  $windowsVersion = [Environment]::OSVersion.Version
  if ($windowsVersion.Major -lt 10) { Stop-Setup 'E200' "Windows 10 or newer is required (detected $windowsVersion)." }
  Add-Step 'Windows' 'OK' "64-bit Windows $windowsVersion"

  try {
    $driveRoot = [System.IO.Path]::GetPathRoot($Root)
    $drive = [System.IO.DriveInfo]::new($driveRoot)
    $freeGb = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
    $requiredGb = if ($InstallFallbackModel -and -not $NoModelDownload) { 12 } else { 4 }
    if ($freeGb -lt $requiredGb) { Stop-Setup 'E211' "At least $requiredGb GB free space is required on $driveRoot (available: $freeGb GB)." }
    Add-Step 'Disk space' 'OK' "$freeGb GB free on $driveRoot; minimum for this setup is $requiredGb GB."
  } catch {
    if ($_.Exception.Message -like 'E211*') { throw }
    Add-Step 'Disk space' 'WARN' 'Free space could not be measured; setup will continue.'
  }

  # PowerShell 5.1 may otherwise negotiate an obsolete protocol with package
  # registries on a clean Windows installation.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Test-EnkeiNotRunning() {
  # npm ci replaces native .node files. On Windows an active dashboard keeps
  # those files locked, so fail early with an actionable message instead of
  # spending minutes installing Python packages before an opaque EPERM.
  $escapedRoot = [regex]::Escape($Root)
  $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $escapedRoot -and $_.CommandLine -match 'vinext|launcher[\\/]runtime-controller\.mjs'
  })
  if ($running.Count -gt 0) {
    if ($WhatIf) { Add-Step 'Running-process check' 'WARN' 'Enkei is running; a real setup would stop here before replacing files.'; return }
    Stop-Setup 'E213' 'Enkei is currently running. Close the Enkei window, wait a few seconds, then run setup again.'
  }
  Add-Step 'Running-process check' 'OK' 'No active Enkei dashboard is locking installation files.'
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  $winget = Find-CommandPath 'winget.exe' @("$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe")
  if (-not $winget) { Stop-Setup 'E201' "Cannot install $Label because Windows App Installer (winget) is unavailable." }
  if ($WhatIf) { Add-Step $Label 'PLAN' "Would install $Id with winget."; return }
  Add-Step $Label 'RUN' 'Installing the missing runtime. Windows may request permission.'
  # Keep winget's progress visible without letting its success output leak
  # into the function return value (callers assign the resolved executable).
  & $winget install --id $Id --exact --accept-package-agreements --accept-source-agreements --silent | Out-Host
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'E202' "$Label installation failed (winget exit $LASTEXITCODE)." }
}

function Ensure-Node() {
  $node = Find-CommandPath 'node.exe' @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  if (-not $node) {
    Install-WingetPackage 'OpenJS.NodeJS.LTS' 'Node.js'
    $node = Find-CommandPath 'node.exe' @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  }
  if (-not $node) { Stop-Setup 'E203' 'Node.js was installed but could not be found. Restart Windows once, then run setup again.' }
  $nodeVersion = & $node --version
  if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { Stop-Setup 'E203' 'Node.js was found but cannot run. Restart Windows once, then run setup again.' }
  $parsedVersion = ConvertTo-Version $nodeVersion 'Node.js'
  if ($parsedVersion -lt $MinimumNode) {
    Stop-Setup 'E203' "Node.js $MinimumNode or newer is required (detected $parsedVersion). Uninstall the old Node.js release or upgrade it, then run setup again."
  }
  Add-Step 'Node.js' 'OK' $nodeVersion
  return $node
}

function Ensure-Python() {
  # Windows App Execution Alias may expose a non-runnable python.exe under
  # WindowsApps.  Prefer real installs and never treat that Store placeholder
  # as a usable runtime.
  $pythonCandidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:ProgramFiles\Python313\python.exe",
    "$env:ProgramFiles\Python312\python.exe",
    "$env:ProgramFiles\Python311\python.exe"
  )
  $python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $python) {
    $candidate = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Source -notlike "$env:LOCALAPPDATA\Microsoft\WindowsApps\*") { $python = $candidate.Source }
  }
  if (-not $python) {
    Install-WingetPackage 'Python.Python.3.12' 'Python'
    if ($WhatIf) { return 'python.exe' }
    $python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $python) { Stop-Setup 'E204' 'Python was installed but could not be found. Restart Windows once, then run setup again.' }
  $pythonVersion = & $python --version
  if ($LASTEXITCODE -ne 0 -or -not $pythonVersion) { Stop-Setup 'E204' 'Python was found but cannot run. Restart Windows once, then run setup again.' }
  $parsedVersion = ConvertTo-Version $pythonVersion 'Python'
  if ($parsedVersion -lt $MinimumPython) {
    Stop-Setup 'E204' "Python $MinimumPython or newer is required (detected $parsedVersion). Install Python 3.12, then run setup again."
  }
  Add-Step 'Python' 'OK' $pythonVersion
  return $python
}

function Ensure-Ollama() {
  $ollama = Find-CommandPath 'ollama.exe' @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")
  if (-not $ollama) {
    Install-WingetPackage 'Ollama.Ollama' 'Ollama'
    if ($WhatIf) { return 'ollama.exe' }
    $ollama = Find-CommandPath 'ollama.exe' @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")
  }
  if (-not $ollama) { Stop-Setup 'E205' 'Ollama was installed but could not be found. Restart Windows once, then run setup again.' }
  $ollamaVersion = & $ollama --version
  if ($LASTEXITCODE -ne 0 -or -not $ollamaVersion) { Stop-Setup 'E205' 'Ollama was found but cannot run. Restart Windows once, then run setup again.' }
  Add-Step 'Ollama' 'OK' $ollamaVersion
  return $ollama
}

function Find-LibreChatDeployment() {
  $configured = [Environment]::GetEnvironmentVariable('ENKEI_LIBRECHAT_HOME')
  $candidates = @(
    $configured,
    (Join-Path $Root 'librechat'),
    (Join-Path (Split-Path -Parent $Root) 'LibreChat'),
    (Join-Path (Split-Path -Parent $Root) '部署\LibreChat')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  foreach ($deploymentRoot in $candidates) {
    foreach ($name in @('deploy-compose.yml', 'docker-compose.yml', 'compose.yml')) {
      $compose = Join-Path $deploymentRoot $name
      if (Test-Path -LiteralPath $compose) { return [pscustomobject]@{ Home = $deploymentRoot; Compose = $compose } }
    }
  }
  return $null
}

function Find-DockerCli() {
  return Find-CommandPath 'docker.exe' @(
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
    "$env:LOCALAPPDATA\Docker\resources\bin\docker.exe"
  )
}

function Wait-DockerEngine([string]$Docker, [int]$Seconds = 120) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      $probe = Start-Process -FilePath $Docker -ArgumentList @('version', '--format', '{{.Server.Version}}') -Wait -PassThru -WindowStyle Hidden
      $dockerExit = $probe.ExitCode
    } catch { $dockerExit = 1 }
    if ($dockerExit -eq 0) { return $true }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-LibreChatRuntime() {
  if ($SkipLibreChat) { Add-Step 'LibreChat gateway' 'SKIP' 'Skipped by request; a remote gateway or local fallback can be configured later.'; return }
  $deployment = Find-LibreChatDeployment
  if (-not $deployment) {
    Add-Step 'LibreChat gateway' 'SKIP' 'No bundled/local LibreChat deployment was found. The dashboard remains usable with a remote gateway or local fallback.'
    return
  }
  $deploymentEnv = Join-Path $deployment.Home '.env'
  if (-not (Test-Path -LiteralPath $deploymentEnv)) {
    $template = Join-Path $deployment.Home '.env.example'
    if (-not (Test-Path -LiteralPath $template)) {
      Stop-Setup 'E215' "LibreChat was found at $($deployment.Home), but its private .env and public template are missing."
    }
    if (-not $WhatIf) {
      $credsKey = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
      $credsIv = [guid]::NewGuid().ToString('N').Substring(0, 32)
      $jwt = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
      $refresh = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
      $content = Get-Content -Raw -LiteralPath $template
      $content = $content -replace '(?m)^CREDS_KEY=.*$', "CREDS_KEY=$credsKey"
      $content = $content -replace '(?m)^CREDS_IV=.*$', "CREDS_IV=$credsIv"
      $content = $content -replace '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwt"
      $content = $content -replace '(?m)^JWT_REFRESH_SECRET=.*$', "JWT_REFRESH_SECRET=$refresh"
      Set-Content -LiteralPath $deploymentEnv -Value $content -Encoding UTF8
    }
  }
  $docker = Find-DockerCli
  if (-not $docker) {
    Install-WingetPackage 'Docker.DockerDesktop' 'Docker Desktop'
    if ($WhatIf) { Add-Step 'LibreChat gateway' 'PLAN' "Would start Docker and deploy $($deployment.Compose)."; return }
    $docker = Find-DockerCli
  }
  if (-not $docker) {
    Add-Step 'LibreChat gateway' 'WARN' 'Docker Desktop was installed but its CLI is not available yet. Enkei setup will continue; the background supervisor will start LibreChat after Docker becomes available.'
    return
  }
  if ($WhatIf) { Add-Step 'LibreChat gateway' 'PLAN' "Would verify Docker and deploy $($deployment.Compose)."; return }

  if (-not (Wait-DockerEngine $docker 4)) {
    $desktop = @(
      "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
      "$env:LOCALAPPDATA\Docker\Docker Desktop.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $alreadyRunning = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
    if (-not $alreadyRunning -and $desktop) {
      Start-Process -FilePath $desktop -WindowStyle Hidden
      Add-Step 'Docker Desktop' 'RUN' 'Started one Docker Desktop instance; waiting for its engine.'
    } elseif ($alreadyRunning) {
      Add-Step 'Docker Desktop' 'RUN' 'Docker Desktop is already starting; waiting without launching a duplicate.'
    }
    if (-not (Wait-DockerEngine $docker 20)) {
      Add-Step 'LibreChat gateway' 'WARN' 'Docker is still starting or requires Windows/WSL2 attention. Enkei setup will continue with local AI fallback; the background supervisor will retry LibreChat automatically.'
      return
    }
  }
  Add-Step 'Docker Desktop' 'OK' 'Docker engine is ready.'
  Push-Location $deployment.Home
  try {
    $priorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $docker compose -f $deployment.Compose up -d | Out-Host
    $composeExit = $LASTEXITCODE
    $ErrorActionPreference = $priorPreference
  } finally { Pop-Location }
  if ($composeExit -ne 0) {
    Add-Step 'LibreChat gateway' 'WARN' "LibreChat containers did not start yet (Docker exit $composeExit). Enkei setup will continue and retry in the background."
    return
  }
  $ready = $false
  $deadline = (Get-Date).AddSeconds(30)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080/' -TimeoutSec 3
      if ($response.StatusCode -lt 500) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if (-not $ready) {
    Add-Step 'LibreChat gateway' 'WARN' 'LibreChat containers are starting. Enkei setup will continue; the background supervisor will keep checking port 3080.'
    return
  }
  Add-Step 'LibreChat gateway' 'OK' "LibreChat is ready on http://127.0.0.1:3080 from $($deployment.Home)."
}

try {
  Write-Host ''
  Write-Host "Enkei first-run setup $SetupVersion"
  Write-Host 'This installs public runtimes only. It never imports MT4 accounts, keys, logs or private model data.'
  Show-SetupProgress 5 'Checking Windows, disk space and existing services.'
  Test-SystemReadiness
  Test-EnkeiNotRunning
  Test-LibreChatRuntime
  Show-SetupProgress 15 'Checking Node.js and Python.'
  $node = Ensure-Node
  $python = Ensure-Python

  $terminalRoot = Join-Path $Root 'ai-terminal'
  $terminalEntry = Join-Path $terminalRoot 'run_terminal.py'
  $requirements = Join-Path $terminalRoot 'requirements.txt'
  $terminalV2Marker = Join-Path $terminalRoot 'app\evaluator.py'
  $researchMarker = Join-Path $terminalRoot 'app\research.py'
  $packageLock = Join-Path $Root 'package-lock.json'
  $launcherMarker = Join-Path $Root 'launcher\runtime-controller.mjs'
  # Decision service (8792) ships with its own bundled venv recipe and a
  # vendored Apache-2.0 copy of TradingAgents, so a clean machine never needs
  # the developer's absolute-path environment.
  $decisionRoot = Join-Path $Root 'decision-service'
  $decisionMarker = Join-Path $decisionRoot 'app.py'
  $decisionReq = Join-Path $decisionRoot 'requirements.txt'
  $decisionLock = Join-Path $decisionRoot 'requirements-lock.txt'
  $decisionScript = Join-Path $decisionRoot 'Start-Decision-Service.cmd'
  $decisionVendor = Join-Path $decisionRoot 'vendor\tradingagents\pyproject.toml'
  $mt4Installer = Join-Path $PSScriptRoot 'Install-EnkeiMt4.ps1'
  if (-not ((Test-Path -LiteralPath $terminalEntry) -and (Test-Path -LiteralPath $requirements) -and (Test-Path -LiteralPath $terminalV2Marker) -and (Test-Path -LiteralPath $researchMarker) -and (Test-Path -LiteralPath $packageLock) -and (Test-Path -LiteralPath $launcherMarker) -and (Test-Path -LiteralPath $decisionMarker) -and (Test-Path -LiteralPath $decisionReq) -and (Test-Path -LiteralPath $decisionLock) -and (Test-Path -LiteralPath $decisionScript) -and (Test-Path -LiteralPath $decisionVendor) -and (Test-Path -LiteralPath $mt4Installer))) {
    Stop-Setup 'E206' 'The bundled AI Terminal v2/v1.7 source is incomplete. Re-download the complete Enkei package.'
  }
  Add-Step 'Package integrity' 'OK' 'Dashboard lockfile, launcher, AI Terminal source and decision service are present.'

  Show-SetupProgress 25 'Preparing optional MT4 integration.'
  Add-Step 'MT4 EA installation' 'RUN' 'Discovering broker MT4 terminals and preparing Enkei EAs. No account or chart setting is changed.'
  $mt4Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $mt4Installer, '-Root', $Root)
  if ($WhatIf) { $mt4Args += '-WhatIf' }
  & PowerShell.exe @mt4Args | Out-Host
  $mt4ExitCode = $LASTEXITCODE
  $mt4ReportName = if ($WhatIf) { 'mt4-install-plan.json' } else { 'mt4-install-report.json' }
  $mt4ReportPath = Join-Path $StateDir $mt4ReportName
  if (Test-Path -LiteralPath $mt4ReportPath) {
    $mt4Report = Get-Content -Raw -LiteralPath $mt4ReportPath | ConvertFrom-Json
    $mt4Status = if ($mt4Report.status -in @('not-installed', 'failed')) { 'WARN' } elseif ($mt4Report.status -eq 'planned') { 'PLAN' } else { 'OK' }
    Add-Step 'MT4 EA installation' $mt4Status $mt4Report.message
  } else {
    Add-Step 'MT4 EA installation' 'WARN' "MT4 integration did not produce a report (exit $mt4ExitCode). Enkei setup will continue."
  }

  Show-SetupProgress 35 'Installing the AI terminal environment.'
  $venvPython = Join-Path $terminalRoot '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython)) {
    if ($WhatIf) { Add-Step 'AI terminal environment' 'PLAN' 'Would create Python virtual environment.' }
    else {
      Add-Step 'AI terminal environment' 'RUN' 'Creating an isolated Python environment.'
      & $python -m venv (Join-Path $terminalRoot '.venv')
      if ($LASTEXITCODE -ne 0) { Stop-Setup 'E207' "Could not create the AI Terminal environment (exit $LASTEXITCODE)." }
    }
  }
  if (-not $WhatIf) {
    Add-Step 'AI terminal environment' 'RUN' 'Installing AI Terminal packages.'
    & $venvPython -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E208' "AI Terminal package installation failed (exit $LASTEXITCODE)." }
    & $venvPython -c "import fastapi, uvicorn, jsonschema, httpx; print('AI Terminal imports OK')"
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E208' 'AI Terminal packages are incomplete. Run setup again; if it repeats, delete ai-terminal\\.venv and retry.' }
    Add-Step 'AI terminal environment' 'OK' 'Required Python packages were imported successfully.'
  }

  # Decision service environment (127.0.0.1:8792).  Uses a package-local
  # virtualenv plus the vendored TradingAgents copy; never the developer's
  # absolute-path venv.  The locked list pins the exact combination that the
  # developer verified upstream.
  Show-SetupProgress 50 'Installing the decision engine. This is usually the longest package step.'
  $decisionVenv = Join-Path $decisionRoot '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $decisionVenv)) {
    if ($WhatIf) { Add-Step 'Decision service environment' 'PLAN' 'Would create decision-service\\.venv.' }
    else {
      Add-Step 'Decision service environment' 'RUN' 'Creating an isolated decision-service environment.'
      & $python -m venv (Join-Path $decisionRoot '.venv')
      if ($LASTEXITCODE -ne 0) { Stop-Setup 'E207' "Could not create the Decision service environment (exit $LASTEXITCODE)." }
    }
  }
  if (-not $WhatIf) {
    Add-Step 'Decision service environment' 'RUN' 'Installing decision-service packages.'
    # 1) Editable install of the vendored engine resolves its bundled
    #    dependencies once, on this machine.
    & $decisionVenv -m pip install --disable-pip-version-check -e (Join-Path $decisionRoot 'vendor\tradingagents')
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E208' "TradingAgents (vendored) install failed (exit $LASTEXITCODE)." }
    # 2) The locked pins then override the floating ranges with the exact
    #    combination validated by the developer.
    & $decisionVenv -m pip install --disable-pip-version-check -r $decisionLock
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E208' "Decision service locked dependency install failed (exit $LASTEXITCODE)." }
    & $decisionVenv -c "import fastapi, uvicorn, jsonschema, httpx, pandas, matplotlib, tabulate; import tradingagents; print('Decision service imports OK')"
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E208' 'Decision service packages are incomplete. Run setup again; if it repeats, delete decision-service\\.venv and retry.' }
    Add-Step 'Decision service environment' 'OK' 'Decision-service packages were installed and imported successfully.'
  }

  # LibreChat is the normal multi-provider gateway.  Ollama remains an
  # optional local fallback, so a clean online-only installation must not
  # download or even require it.
  Show-SetupProgress 72 'Checking the optional local AI model.'
  $ollama = Find-CommandPath 'ollama.exe' @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")
  if (-not $ollama -and $InstallFallbackModel -and -not $NoModelDownload) { $ollama = Ensure-Ollama }
  $installedModels = @()
  if ($ollama -and -not $WhatIf) {
    $installedModels = @(& $ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object {
      $parts = $_ -split '\s+'
      if ($parts.Count -gt 0) { $parts[0].Trim() }
    } | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { $installedModels = @() }
  }
  $hasDefaultModel = $installedModels -contains $DefaultModel
  if ($InstallFallbackModel -and -not $NoModelDownload -and -not $hasDefaultModel) {
    if ($WhatIf) { Add-Step 'Local fallback model' 'PLAN' "Would download $DefaultModel with Ollama." }
    else {
      Add-Step 'Local fallback model' 'RUN' "Downloading optional $DefaultModel. This can take several GB and may take time."
      & $ollama pull $DefaultModel
      if ($LASTEXITCODE -ne 0) { Stop-Setup 'E209' "The optional local model download failed (exit $LASTEXITCODE). Online models can still be configured later." }
      $hasDefaultModel = $true
    }
  } elseif ($hasDefaultModel) {
    Add-Step 'Local fallback model' 'OK' "Detected installed model $DefaultModel."
  } else {
    Add-Step 'Local fallback model' 'SKIP' 'No local model was required. LibreChat or another online gateway can be configured first; a local fallback remains optional.'
  }

  # Never write the terminal's provider file here.  The AI gateway owns its
  # configuration and may migrate its format independently.  Keeping all
  # private material outside the distributable project also prevents setup
  # reruns from overwriting an existing LibreChat connection.
  $privateConfigRoot = Join-Path $env:LOCALAPPDATA 'Enkei\private-config'
  if ($WhatIf) { Add-Step 'Private AI configuration' 'PLAN' "Would ensure $privateConfigRoot exists without changing its contents." }
  else {
    New-Item -ItemType Directory -Force -Path $privateConfigRoot | Out-Null
    $gatewayPath = Join-Path $privateConfigRoot 'gateway.json'
    if (-not (Test-Path -LiteralPath $gatewayPath)) {
      $initialGateway = [ordered]@{
        librechat_base_url = 'http://127.0.0.1:3080'
        librechat_api_key = ''
        unified_analysis_enabled = $true
        unified_agent_id = ''
        m5_agent_id = ''
        m15_agent_id = ''
        local_fallback_enabled = [bool]$hasDefaultModel
        ollama_base_url = 'http://127.0.0.1:11434'
        ollama_fallback_model = $(if ($hasDefaultModel) { $DefaultModel } else { '' })
        configured = $false
      }
      $initialGateway | ConvertTo-Json | Set-Content -LiteralPath $gatewayPath -Encoding UTF8
    }
    Add-Step 'Private AI configuration' 'OK' 'Private configuration directory is ready; existing gateway and user settings were preserved.'
  }

  # Prepare a local-only LibreChat environment from the public template. The
  # generated secrets never enter the release archive and existing values are
  # never overwritten on a repair install.
  $libreChatHome = Join-Path $Root 'librechat'
  $libreChatTemplate = Join-Path $libreChatHome '.env.example'
  $libreChatEnv = Join-Path $libreChatHome '.env'
  if (-not $WhatIf -and (Test-Path -LiteralPath $libreChatTemplate) -and -not (Test-Path -LiteralPath $libreChatEnv)) {
    $credsKey = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $credsIv = [guid]::NewGuid().ToString('N').Substring(0, 32)
    $jwt = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $refresh = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $content = Get-Content -Raw -LiteralPath $libreChatTemplate
    $content = $content -replace '(?m)^CREDS_KEY=.*$', "CREDS_KEY=$credsKey"
    $content = $content -replace '(?m)^CREDS_IV=.*$', "CREDS_IV=$credsIv"
    $content = $content -replace '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwt"
    $content = $content -replace '(?m)^JWT_REFRESH_SECRET=.*$', "JWT_REFRESH_SECRET=$refresh"
    Set-Content -LiteralPath $libreChatEnv -Value $content -Encoding UTF8
    Add-Step 'LibreChat configuration' 'OK' 'Local LibreChat configuration and private runtime secrets were created.'
  }

  if (-not $WhatIf) {
    Show-SetupProgress 85 'Installing and verifying the dashboard.'
    Add-Step 'Dashboard packages' 'RUN' 'Installing dashboard packages.'
    $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { $npm = Find-CommandPath 'npm.cmd' @() }
    if (-not $npm) { Stop-Setup 'E210' 'Node.js is present but npm could not be found.' }
    Push-Location $Root
    try { & $npm ci --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E210' "Dashboard package installation failed (exit $LASTEXITCODE)." }
    Push-Location $Root
    try { & $npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'E212' "Dashboard verification build failed (exit $LASTEXITCODE)." }
    Add-Step 'Dashboard verification' 'OK' 'Production build completed successfully; first launch is pre-warmed.'
  } else { Add-Step 'Dashboard packages' 'PLAN' 'Would run npm ci.' }

  if ($WhatIf) {
    Add-Step 'setup' 'PLAN' 'First-run validation plan completed without changing the machine.'
    Save-Report 'planned' 'E000' 'First-run setup plan completed without changing the machine.'
    exit 0
  }

  Show-SetupProgress 100 'Setup complete. Starting Enkei.'
  Write-Progress -Activity 'Enkei first-run setup' -Completed
  Add-Step 'setup' 'OK' 'First-run validation completed.'
  Save-Report 'passed' 'E000' 'First-run setup completed.'
  if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $Root 'Start-Enkei.cmd') -WorkingDirectory $Root }
  exit 0
} catch {
  # A report from an earlier successful run must never hide a new failure.
  if (-not $script:ReportFinalized) { Save-Report 'failed' 'E299' $_.Exception.Message }
  Write-Host ''
  Write-Host "Setup stopped: $($_.Exception.Message)"
  Write-Host "Diagnostic: $ReportPath"
  exit 1
}
