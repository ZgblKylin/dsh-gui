#Requires -Version 5.1
<#
.SYNOPSIS
  Rebuild the harness and/or the entry exe after changing code.

.PARAMETER SkipHarness
  Skip the harness install + build (only rebuild the exe).
#>
[CmdletBinding()]
param(
    [switch]$SkipHarness
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Toolchain = Join-Path $Root '.toolchain'
$Store     = Join-Path $Root '.pnpm-store'
$Harness   = Join-Path $Root 'deepseek-harness'
$SrcTauri  = Join-Path $Root 'src-tauri'

$PnpmShim = Join-Path $Toolchain 'pnpm.cmd'
if (-not (Test-Path $PnpmShim)) {
    throw "pnpm is not bootstrapped yet — run scripts\setup.ps1 once."
}

if (-not $SkipHarness) {
    Write-Host "==> pnpm install (repo-local store)" -ForegroundColor Cyan
    Push-Location $Harness
    try {
        $env:CI = 'true'  # skip the harness's lefthook git-hook setup (dev-only)
        & $PnpmShim install --store-dir $Store
    } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }

    Write-Host "==> pnpm build" -ForegroundColor Cyan
    Push-Location $Harness
    try { & $PnpmShim run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE" }
}

Write-Host "==> cargo build" -ForegroundColor Cyan
Push-Location $SrcTauri
try { cargo build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }

Write-Host "==> copy entry exe to the repository root" -ForegroundColor Cyan
Copy-Item -Force (Join-Path $SrcTauri 'target\debug\dsh-gui.exe') (Join-Path $Root 'dsh-gui.exe')

# Plugins: build + install every package under plugins/ into the web profile.
& (Join-Path $PSScriptRoot 'install-plugins.ps1')

Write-Host "`nDone. Entry exe: $Root\dsh-gui.exe" -ForegroundColor Green
