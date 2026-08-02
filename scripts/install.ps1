<#
.SYNOPSIS
  veneko-cli installer for Windows.

.DESCRIPTION
  Installs veneko under %LOCALAPPDATA%\veneko, puts a launcher on your user PATH
  and sets up the optional Python tools. Nothing is written outside your user
  profile and no administrator rights are required.

.EXAMPLE
  irm https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Yes -NoFfmpeg

.NOTES
  A piped install cannot receive parameters, so every switch is also read from
  the environment: VENEKO_HOME, VENEKO_BIN_DIR, VENEKO_VERSION, VENEKO_YES,
  VENEKO_NO_PYTHON, VENEKO_NO_FFMPEG, VENEKO_NO_PATH, VENEKO_VERBOSE.

      $env:VENEKO_NO_PYTHON = '1'
      irm .../install.ps1 | iex
#>

[CmdletBinding()]
param(
  # Do not ask anything; take the safe default for every prompt.
  [switch] $Yes,
  # Install a specific release tag instead of the latest one.
  [string] $Release = $env:VENEKO_VERSION,
  # Where veneko is installed.
  [string] $Prefix = $(if ($env:VENEKO_HOME) { $env:VENEKO_HOME } else { Join-Path $env:LOCALAPPDATA 'veneko' }),
  # Skip markitdown and yt-dlp.
  [switch] $NoPython,
  # Skip the ffmpeg install.
  [switch] $NoFfmpeg,
  # Do not touch the user PATH.
  [switch] $NoPath,
  # Show the full output of every command.
  [switch] $ShowOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 still defaults to TLS 1.0, which github.com rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoOwner = 'ChristianVeneko'
$RepoName = 'veneko-cli'
$RepoUrl = "https://github.com/$RepoOwner/$RepoName"
$ApiUrl = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
$MinNodeMajor = 22
$TotalSteps = 9

# `irm … | iex` cannot pass parameters, and that is the documented way to
# install, so every switch is also readable from the environment.
if ($env:VENEKO_YES -eq '1') { $Yes = $true }
if ($env:VENEKO_NO_PYTHON -eq '1') { $NoPython = $true }
if ($env:VENEKO_NO_FFMPEG -eq '1') { $NoFfmpeg = $true }
if ($env:VENEKO_NO_PATH -eq '1') { $NoPath = $true }
if ($env:VENEKO_VERBOSE -eq '1') { $ShowOutput = $true }

$AppDir = Join-Path $Prefix 'app'
$StageDir = Join-Path $Prefix '.stage'
$BackupDir = Join-Path $Prefix '.previous'
$BinDir = if ($env:VENEKO_BIN_DIR) { $env:VENEKO_BIN_DIR } else { Join-Path $Prefix 'bin' }

$script:CurrentStep = 0
$script:CurrentTask = 'starting up'
$script:LogFile = Join-Path $env:TEMP "veneko-install-$PID.log"
$script:WorkDir = $null
$script:PathUpdated = $false
$script:ResolvedTag = 'main'
$script:ArchiveUrl = "$RepoUrl/archive/refs/heads/main.zip"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Write-Step {
  param([string] $Message)
  $script:CurrentStep++
  $script:CurrentTask = $Message
  Write-Host ("[{0}/{1}] " -f $script:CurrentStep, $TotalSteps) -ForegroundColor Cyan -NoNewline
  Write-Host $Message
}

function Write-Info { param([string] $Message) Write-Host "      $Message" -ForegroundColor DarkGray }
function Write-Ok   { param([string] $Message) Write-Host "      + " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Warn { param([string] $Message) Write-Host "      ! " -ForegroundColor Yellow -NoNewline; Write-Host $Message }

function Write-Banner {
  $art = @(
    '  ##   ## ####### ###   ## ####### ##  ##  ######',
    '  ##   ## ##      ####  ## ##      ## ##  ##    ##',
    '  ##   ## #####   ## ## ## #####   ####   ##    ##',
    '   ## ##  ##      ##  #### ##      ## ##  ##    ##',
    '    ###   ####### ##   ### ####### ##  ##  ######'
  )
  Write-Host ''
  foreach ($line in $art) { Write-Host $line -ForegroundColor Cyan }
  Write-Host '  installer for Windows' -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------

function Restore-Backup {
  # Puts back the previous install when the swap happened but a later step
  # failed. Better a working old version than a half-replaced one.
  if ((Test-Path $BackupDir) -and -not (Test-Path $AppDir)) {
    try {
      Move-Item -LiteralPath $BackupDir -Destination $AppDir -Force
      Write-Warn 'Restored the previous installation.'
    } catch {
      Write-Warn "Could not restore the previous installation from $BackupDir."
    }
  }
}

function Remove-Temp {
  if ($script:WorkDir -and (Test-Path $script:WorkDir)) {
    Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $StageDir) {
    Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Stop-WithError {
  param([string] $Message)

  Write-Host ''
  Write-Host "X Installation failed while: $($script:CurrentTask)" -ForegroundColor Red
  Write-Host "  $Message" -ForegroundColor Red
  Write-Host ''

  if (Test-Path $script:LogFile) {
    $tail = Get-Content -LiteralPath $script:LogFile -Tail 25 -ErrorAction SilentlyContinue
    if ($tail) {
      Write-Host 'Last lines of the command output:'
      $tail | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
      Write-Host ''
      Write-Host "Full log: $($script:LogFile)" -ForegroundColor DarkGray
    }
  }

  Write-Host ''
  Write-Host 'If this looks like a bug, open an issue with the log attached:' -ForegroundColor DarkGray
  Write-Host "  $RepoUrl/issues" -ForegroundColor DarkGray
  Write-Host ''

  Restore-Backup
  Remove-Temp
  exit 1
}

# Runs an external command, hiding its output unless -ShowOutput or a failure.
function Invoke-Step {
  param(
    [Parameter(Mandatory)] [string] $Command,
    [string[]] $Arguments = @(),
    [string] $WorkingDirectory
  )

  $previous = $null
  if ($WorkingDirectory) {
    $previous = Get-Location
    Set-Location -LiteralPath $WorkingDirectory
  }

  # Windows PowerShell turns every stderr line of a native command into an
  # ErrorRecord, and with ErrorActionPreference=Stop npm's ordinary warnings
  # would abort the install. Errors are judged by exit code here, not by stderr.
  $outerPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0

  try {
    if ($ShowOutput) {
      & $Command @Arguments 2>&1 | Tee-Object -FilePath $script:LogFile -Append | Out-Host
    } else {
      & $Command @Arguments 2>&1 | Out-File -FilePath $script:LogFile -Append -Encoding utf8
    }
    return ($LASTEXITCODE -eq 0)
  } catch {
    $_ | Out-File -FilePath $script:LogFile -Append -Encoding utf8
    return $false
  } finally {
    $ErrorActionPreference = $outerPreference
    if ($previous) { Set-Location -LiteralPath $previous }
  }
}

function Test-Command {
  param([string] $Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Read-YesNo {
  param([string] $Question, [string] $Default = 'y')

  if ($Yes -or -not [Environment]::UserInteractive) {
    return ($Default -eq 'y')
  }

  $hint = if ($Default -eq 'y') { '[Y/n]' } else { '[y/N]' }
  $reply = Read-Host "      $Question $hint"
  if ([string]::IsNullOrWhiteSpace($reply)) { $reply = $Default }
  return ($reply.Trim().ToLowerInvariant() -in @('y', 'yes'))
}

# ---------------------------------------------------------------------------
# 1. Environment
# ---------------------------------------------------------------------------

function Test-Environment {
  Write-Step 'Checking this machine'
  Write-Info ("Windows {0} ({1})" -f [Environment]::OSVersion.Version, $env:PROCESSOR_ARCHITECTURE)

  if (-not (Test-Command 'node')) {
    Stop-WithError @"
Node.js is not installed.

  veneko runs on Node.js $MinNodeMajor or newer. Install it with:

    winget install OpenJS.NodeJS.LTS

  or download it from https://nodejs.org, then run this installer again.
"@
  }

  $nodeVersion = (& node -v).Trim()
  $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt $MinNodeMajor) {
    Stop-WithError "Node.js $nodeVersion is too old - veneko needs $MinNodeMajor or newer. Upgrade Node.js and try again."
  }
  Write-Ok "Node.js $nodeVersion"

  if (-not (Test-Command 'npm')) {
    Stop-WithError 'npm is not installed, but it ships with Node.js. Reinstall Node.js from https://nodejs.org.'
  }
  Write-Ok "npm $((& npm -v).Trim())"
}

# ---------------------------------------------------------------------------
# 2. Which version
# ---------------------------------------------------------------------------

function Resolve-Release {
  Write-Step 'Resolving the version to install'

  if ($Release) {
    $script:ResolvedTag = $Release
    $script:ArchiveUrl = "$RepoUrl/archive/refs/tags/$Release.zip"
    Write-Ok "Requested release $Release"
    return
  }

  $headers = @{
    'Accept'     = 'application/vnd.github+json'
    'User-Agent' = "$RepoName-installer"
  }

  try {
    $payload = Invoke-RestMethod -Uri $ApiUrl -Headers $headers -TimeoutSec 20
    if ($payload.tag_name) {
      $script:ResolvedTag = $payload.tag_name
      $script:ArchiveUrl = "$RepoUrl/archive/refs/tags/$($payload.tag_name).zip"
      Write-Ok "Latest release: $($payload.tag_name)"
      return
    }
  } catch {
    # No published release yet, or the repository cannot be read at all.
  }

  # Fall back to the default branch - but ask GitHub which one that is instead
  # of assuming `main`, and treat an unreachable repository as a hard error:
  # downloading a 404 page and calling it a source tree is worse than stopping.
  $defaultBranch = $null
  try {
    $repoInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoOwner/$RepoName" -Headers $headers -TimeoutSec 20
    $defaultBranch = $repoInfo.default_branch
  } catch {
    $defaultBranch = $null
  }

  if (-not $defaultBranch) {
    Stop-WithError @"
GitHub does not return anything for $RepoOwner/$RepoName.

  The most likely reasons are:

    - the repository is private; a public repository is required for this
      installer, since it downloads without any credentials
    - GitHub rate-limited this IP address (try again in a few minutes)
    - you are offline

  Check it here: $RepoUrl
"@
  }

  $script:ResolvedTag = $defaultBranch
  $script:ArchiveUrl = "$RepoUrl/archive/refs/heads/$defaultBranch.zip"
  Write-Warn "No published release found - installing from the '$defaultBranch' branch instead."
}

# ---------------------------------------------------------------------------
# 3. Download
# ---------------------------------------------------------------------------

function Get-Source {
  Write-Step "Downloading veneko $($script:ResolvedTag)"

  $script:WorkDir = Join-Path $env:TEMP "veneko-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  New-Item -ItemType Directory -Path $script:WorkDir -Force | Out-Null
  $archive = Join-Path $script:WorkDir 'source.zip'

  try {
    Invoke-WebRequest -Uri $script:ArchiveUrl -OutFile $archive -UseBasicParsing -TimeoutSec 120
  } catch {
    Stop-WithError @"
Could not download $($script:ArchiveUrl)

  Check your internet connection, or that the tag exists:
    $RepoUrl/releases
"@
  }

  $extractDir = Join-Path $script:WorkDir 'extracted'
  Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force

  # GitHub wraps everything in a `veneko-cli-<tag>` folder.
  $root = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
  if (-not $root -or -not (Test-Path (Join-Path $root.FullName 'package.json'))) {
    Stop-WithError 'The downloaded archive does not look like veneko-cli.'
  }

  if (Test-Path $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $StageDir -Parent) -Force | Out-Null
  Move-Item -LiteralPath $root.FullName -Destination $StageDir -Force

  Write-Ok 'Source extracted'
}

# ---------------------------------------------------------------------------
# 4. JavaScript dependencies and build
# ---------------------------------------------------------------------------

function Build-App {
  Write-Step 'Installing JavaScript dependencies'
  Write-Info 'npm is downloading packages - this takes a minute the first time.'

  $installed = $false
  if (Test-Path (Join-Path $StageDir 'package-lock.json')) {
    # npm ci is reproducible but refuses to run when the lockfile drifted from
    # package.json, which is exactly when a plain install is the right answer.
    $installed = Invoke-Step -Command 'npm' -Arguments @('ci', '--no-audit', '--no-fund') -WorkingDirectory $StageDir
    if (-not $installed) { Write-Warn 'npm ci failed; retrying with npm install.' }
  }
  if (-not $installed) {
    $installed = Invoke-Step -Command 'npm' -Arguments @('install', '--no-audit', '--no-fund') -WorkingDirectory $StageDir
  }
  if (-not $installed) {
    Stop-WithError 'npm could not install the dependencies.'
  }
  Write-Ok 'Dependencies installed'

  Write-Step 'Building veneko'
  if (-not (Invoke-Step -Command 'npm' -Arguments @('run', 'build') -WorkingDirectory $StageDir)) {
    Stop-WithError 'The build failed.'
  }
  if (-not (Test-Path (Join-Path $StageDir 'dist\index.js'))) {
    Stop-WithError 'The build finished but dist\index.js is missing.'
  }

  # Build tools are dead weight once dist\ exists.
  Invoke-Step -Command 'npm' -Arguments @('prune', '--omit=dev') -WorkingDirectory $StageDir | Out-Null
  Write-Ok "Built $($script:ResolvedTag)"
}

# ---------------------------------------------------------------------------
# 5. Install
# ---------------------------------------------------------------------------

function Install-App {
  Write-Step "Installing to $Prefix"

  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

  if (Test-Path $BackupDir) { Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue }

  if (Test-Path $AppDir) {
    # `veneko update` runs from inside this folder, and Windows refuses to move
    # a directory while a file in it is open. A short retry covers the moment
    # the old process releases its handles.
    $moved = $false
    foreach ($attempt in 1..5) {
      try {
        Move-Item -LiteralPath $AppDir -Destination $BackupDir -Force
        $moved = $true
        break
      } catch {
        Start-Sleep -Milliseconds 400
      }
    }
    if (-not $moved) {
      Stop-WithError @"
Could not replace the existing installation at $AppDir

  A file in it is still in use. Close every terminal running veneko and
  run the installer again.
"@
    }
  }

  Move-Item -LiteralPath $StageDir -Destination $AppDir -Force
  Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok "Files in place at $AppDir"

  $entry = Join-Path $AppDir 'dist\index.js'

  # A .cmd shim is what cmd.exe, PowerShell and every IDE terminal can launch.
  @"
@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo veneko: Node.js was not found on PATH. Install Node.js $MinNodeMajor+ and try again. 1>&2
  exit /b 1
)
node "$entry" %*
"@ | Set-Content -LiteralPath (Join-Path $BinDir 'veneko.cmd') -Encoding ASCII

  # ...and a .ps1 sibling so PowerShell keeps the exit code and argument array.
  @"
#!/usr/bin/env pwsh
# Generated by the veneko-cli installer. Do not edit; reinstalling overwrites it.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "veneko: Node.js was not found on PATH. Install Node.js $MinNodeMajor+ and try again."
  exit 1
}
& node "$entry" @args
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath (Join-Path $BinDir 'veneko.ps1') -Encoding UTF8

  Write-Ok "Launcher written to $BinDir\veneko.cmd"
}

# ---------------------------------------------------------------------------
# 6. PATH
# ---------------------------------------------------------------------------

function Add-ToPath {
  Write-Step 'Making `veneko` available on your PATH'

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }

  $entries = $userPath.Split(';') | Where-Object { $_ -ne '' }
  if ($entries -contains $BinDir) {
    Write-Ok "$BinDir is already on your PATH"
    if ($env:Path -notlike "*$BinDir*") { $env:Path = "$BinDir;$env:Path" }
    return
  }

  if ($NoPath) {
    Write-Warn 'Skipped (-NoPath). Add this folder to your PATH yourself:'
    Write-Info $BinDir
    return
  }

  $newPath = if ($userPath.TrimEnd(';')) { "$($userPath.TrimEnd(';'));$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$BinDir;$env:Path"

  $script:PathUpdated = $true
  Write-Ok "Added $BinDir to your user PATH"
}

# ---------------------------------------------------------------------------
# 7. Optional tools
# ---------------------------------------------------------------------------

function Find-Python {
  # `py` is the Windows launcher and is the most reliable entry point; the
  # bare `python` on PATH is often the Microsoft Store stub, which does nothing.
  foreach ($candidate in @('py', 'python3', 'python')) {
    if (-not (Test-Command $candidate)) { continue }

    $source = (Get-Command $candidate | Select-Object -First 1).Source
    if ($source -and $source -match '\\WindowsApps\\') { continue }

    try {
      # The snippet deliberately contains no quotes. Windows PowerShell rebuilds
      # the command line for a native process and drops embedded double quotes,
      # so `print("%d.%d" % ...)` reaches Python as a syntax error. Encoding the
      # version as one integer - 3.13 becomes 313 - sidesteps quoting entirely
      # and makes the comparison a single number.
      # `$args` is an automatic variable in PowerShell, so it cannot be reused here.
      $probe = @('-c', 'import sys; print(sys.version_info[0]*100 + sys.version_info[1])')
      if ($candidate -eq 'py') { $probe = @('-3') + $probe }

      $encoded = (& $candidate @probe 2>$null | Select-Object -First 1)
      if (-not $encoded) { continue }

      $number = 0
      if (-not [int]::TryParse($encoded.Trim(), [ref] $number)) { continue }

      # 310 is Python 3.10, the floor markitdown needs.
      if ($number -ge 310) {
        $major = [math]::Floor($number / 100)
        $minor = $number % 100
        return @{
          Command  = $candidate
          Version  = "$major.$minor"
          BaseArgs = $(if ($candidate -eq 'py') { @('-3') } else { @() })
        }
      }
    } catch {
      continue
    }
  }
  return $null
}

function Install-PythonTools {
  Write-Step 'Setting up the optional Python tools'

  if ($NoPython) {
    Write-Warn 'Skipped (-NoPython). Document conversion and downloads will not work until you install them.'
    return
  }

  $python = Find-Python
  if (-not $python) {
    Write-Warn 'No Python 3.10+ found - skipping markitdown and yt-dlp.'
    Write-Info 'They power the document and download tools. Install Python with:'
    Write-Info '  winget install Python.Python.3.12'
    return
  }
  Write-Ok "Python $($python.Version) found ($($python.Command))"

  if (-not (Test-Command 'pipx')) {
    if (-not (Read-YesNo 'pipx is missing. Install it (isolated, user-level)?' 'y')) {
      Write-Warn 'Skipped. Install the tools yourself with: pipx install "markitdown[all]" yt-dlp'
      return
    }

    Write-Info 'Installing pipx...'
    if (-not (Invoke-Step -Command $python.Command -Arguments ($python.BaseArgs + @('-m', 'pip', 'install', '--user', 'pipx')))) {
      Write-Warn 'Could not install pipx. Install Python from python.org and try again.'
      return
    }
    Invoke-Step -Command $python.Command -Arguments ($python.BaseArgs + @('-m', 'pipx', 'ensurepath')) | Out-Null

    # ensurepath edits the persisted PATH, not this session's copy.
    $env:Path = "$([Environment]::GetEnvironmentVariable('Path', 'User'));$env:Path"
    if (-not (Test-Command 'pipx')) {
      Write-Warn 'pipx was installed but is not on PATH yet. Open a new terminal and run: veneko doctor'
      return
    }
    Write-Ok 'pipx installed'
  }

  foreach ($tool in @(
    @{ Package = 'markitdown[all]'; Name = 'markitdown'; What = 'document to Markdown conversion' },
    @{ Package = 'yt-dlp'; Name = 'yt-dlp'; What = 'video and audio downloads' }
  )) {
    Write-Info "Installing $($tool.Name) ($($tool.What))..."
    if (Invoke-Step -Command 'pipx' -Arguments @('install', $tool.Package)) {
      Write-Ok "$($tool.Name) installed"
    } elseif (Invoke-Step -Command 'pipx' -Arguments @('upgrade', $tool.Name)) {
      Write-Ok "$($tool.Name) is already installed and up to date"
    } else {
      Write-Warn "Could not install $($tool.Name) automatically."
      Write-Info "Try it by hand: pipx install `"$($tool.Package)`""
    }
  }
}

function Install-Ffmpeg {
  Write-Step 'Checking ffmpeg'

  if (Test-Command 'ffmpeg') {
    Write-Ok 'ffmpeg is installed'
    return
  }

  if ($NoFfmpeg) {
    Write-Warn 'ffmpeg is missing (-NoFfmpeg). Audio extraction and high-quality video will not work.'
    return
  }

  if (-not (Test-Command 'winget')) {
    Write-Warn 'ffmpeg is not installed - yt-dlp needs it for audio and merged video.'
    Write-Info 'Install winget (App Installer) from the Microsoft Store, then: winget install Gyan.FFmpeg'
    return
  }

  if (-not (Read-YesNo 'ffmpeg is missing. Install it with winget?' 'y')) {
    Write-Warn 'Skipped. Install it later with: winget install Gyan.FFmpeg'
    return
  }

  Write-Info 'Installing ffmpeg (winget may take a couple of minutes)...'
  $ok = Invoke-Step -Command 'winget' -Arguments @(
    'install', '--id', 'Gyan.FFmpeg', '-e', '--silent',
    '--accept-package-agreements', '--accept-source-agreements'
  )

  if ($ok) {
    Write-Ok 'ffmpeg installed - open a new terminal for it to appear on PATH'
  } else {
    Write-Warn 'winget could not install ffmpeg. Run: winget install Gyan.FFmpeg'
  }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

function Write-Summary {
  $version = $script:ResolvedTag
  try {
    $pkg = Get-Content -LiteralPath (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json
    if ($pkg.version) { $version = $pkg.version }
  } catch { }

  Write-Host ''
  Write-Host "+ veneko $version is installed." -ForegroundColor Green
  Write-Host ''
  Write-Host "  Installed to  $AppDir"
  Write-Host "  Launcher      $BinDir\veneko.cmd"
  Write-Host "  Config        $(Join-Path $env:USERPROFILE '.veneko\config.json')"
  Write-Host ''

  if ($script:PathUpdated) {
    Write-Host '  Your user PATH was updated.' -ForegroundColor Yellow
    Write-Host '  Open a new terminal for `veneko` to be found.' -ForegroundColor Yellow
    Write-Host ''
  }

  Write-Host '  Next steps'
  Write-Host '    veneko            ' -NoNewline; Write-Host 'open the interactive menu' -ForegroundColor DarkGray
  Write-Host '    veneko doctor     ' -NoNewline; Write-Host 'confirm everything is wired up' -ForegroundColor DarkGray
  Write-Host '    veneko config     ' -NoNewline; Write-Host 'add an AI provider API key' -ForegroundColor DarkGray
  Write-Host '    veneko update     ' -NoNewline; Write-Host 'upgrade to a newer release' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host "  $RepoUrl" -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------------------

try {
  Write-Banner
  Test-Environment
  Resolve-Release
  Get-Source
  Build-App
  Install-App
  Add-ToPath
  Install-PythonTools
  Install-Ffmpeg
  Remove-Temp
  Write-Summary
} catch {
  Stop-WithError $_.Exception.Message
}
