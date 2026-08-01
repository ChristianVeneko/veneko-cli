<#
.SYNOPSIS
  Removes veneko-cli from Windows.

.DESCRIPTION
  Deletes the installation and the launcher, and takes the launcher folder back
  out of your user PATH. Your API keys in %USERPROFILE%\.veneko\config.json are
  kept unless you pass -Purge. The Python tools and ffmpeg are left alone: they
  are useful on their own and were probably not installed only for veneko.

.EXAMPLE
  irm https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/uninstall.ps1 | iex
#>

[CmdletBinding()]
param(
  # Also delete the configuration and stored API keys.
  [switch] $Purge,
  [string] $Prefix = $(if ($env:VENEKO_HOME) { $env:VENEKO_HOME } else { Join-Path $env:LOCALAPPDATA 'veneko' })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BinDir = if ($env:VENEKO_BIN_DIR) { $env:VENEKO_BIN_DIR } else { Join-Path $Prefix 'bin' }
$ConfigDir = Join-Path $env:USERPROFILE '.veneko'
$removed = 0

function Remove-Target {
  param([string] $Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
    Write-Host '  + ' -ForegroundColor Green -NoNewline
    Write-Host "removed $Path"
    $script:removed++
  }
}

Write-Host ''
Write-Host 'Uninstalling veneko-cli' -ForegroundColor White
Write-Host ''

Remove-Target (Join-Path $Prefix 'app')
Remove-Target (Join-Path $Prefix '.stage')
Remove-Target (Join-Path $Prefix '.previous')
Remove-Target (Join-Path $BinDir 'veneko.cmd')
Remove-Target (Join-Path $BinDir 'veneko.ps1')

# Take the launcher folder back out of the user PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $entries = $userPath.Split(';') | Where-Object { $_ -ne '' -and $_ -ne $BinDir }
  $newPath = $entries -join ';'
  if ($newPath -ne $userPath) {
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host '  + ' -ForegroundColor Green -NoNewline
    Write-Host "removed $BinDir from your user PATH"
    $removed++
  }
}

if ($Purge) {
  Remove-Target $ConfigDir
  Remove-Target $Prefix
} elseif (Test-Path -LiteralPath (Join-Path $ConfigDir 'config.json')) {
  Write-Host '  ! ' -ForegroundColor Yellow -NoNewline
  Write-Host "kept $ConfigDir\config.json " -NoNewline
  Write-Host '(use -Purge to delete it)' -ForegroundColor DarkGray
}

Write-Host ''
if ($removed -eq 0) {
  Write-Host "  Nothing to remove - veneko was not installed at $Prefix."
} else {
  Write-Host 'veneko-cli is uninstalled.' -ForegroundColor Green
  Write-Host '  Open a new terminal for the PATH change to take effect.' -ForegroundColor DarkGray
}
Write-Host ''
