#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot, self-contained build of the dsh-gui desktop shell.

.DESCRIPTION
  Bootstraps a repo-local pinned pnpm (11.7.0), installs the deepseek-harness
  submodule into the project directory using a repo-local store, builds the
  harness (host lib + web dist), and compiles the entry exe, copied to the
  repository root as dsh-gui.exe.

  No global or out-of-tree runtime state is created: everything lands under this
  repository and is covered by .gitignore (.toolchain/, .pnpm-store/, .dsh/,
  src-tauri\target\).

.PARAMETER SkipCargo
  Skip the final `cargo build` (rebuild the exe later with scripts\build.ps1).
#>
[CmdletBinding()]
param(
    [switch]$SkipCargo
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Toolchain = Join-Path $Root '.toolchain'
$Store     = Join-Path $Root '.pnpm-store'
$Harness   = Join-Path $Root 'deepseek-harness'
$SrcTauri  = Join-Path $Root 'src-tauri'

function Resolve-PnpmShim {
    # `npm i -g --prefix <dir>` writes the .cmd shim at <dir>\pnpm.cmd (and, on
    # some npm layouts, under node_modules\.bin). Detect whichever exists.
    foreach ($candidate in @(
        (Join-Path $Toolchain 'pnpm.cmd'),
        (Join-Path $Toolchain 'node_modules\.bin\pnpm.cmd'),
        (Join-Path $Toolchain 'pnpm.CMD')
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Invoke-Step([string]$Name, [scriptblock]$Body) {
    Write-Host "`n==> $Name" -ForegroundColor Cyan
    & $Body
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

# 1) Pinned pnpm bootstrap ---------------------------------------------------
$PnpmShim = Resolve-PnpmShim
if (-not $PnpmShim) {
    Invoke-Step 'Bootstrap pnpm@11.7.0 into .toolchain' {
        New-Item -ItemType Directory -Force -Path $Toolchain | Out-Null
        # --cache keeps npm's own cache inside .toolchain (repo-local, gitignored).
        npm install --global --prefix $Toolchain --cache (Join-Path $Toolchain 'npm-cache') pnpm@11.7.0
    }
    $PnpmShim = Resolve-PnpmShim
    if (-not $PnpmShim) { throw 'pnpm bootstrap did not produce a pnpm.cmd shim under .toolchain' }
} else {
    Write-Host 'pnpm already bootstrapped; skipping.'
}

# 2) Harness dependency install (repo-local store) ---------------------------
# CI=true makes the harness's postinstall skip its git-hook (lefthook) setup,
# which otherwise fails inside a submodule checkout (`core.worktree` lives in
# the submodule's common git config). Git hooks are dev-only and irrelevant to
# the desktop shell.
Invoke-Step 'Install harness dependencies (repo-local store)' {
    Push-Location $Harness
    try {
        $env:CI = 'true'
        & $PnpmShim install --store-dir $Store --frozen-lockfile
    } finally {
        Pop-Location
    }
}

# 3) Harness build (host lib + web dist) -------------------------------------
Invoke-Step 'Build harness (host lib + web dist)' {
    Push-Location $Harness
    try {
        & $PnpmShim run build
    } finally {
        Pop-Location
    }
}

# 4) Tauri entry exe ---------------------------------------------------------
if (-not $SkipCargo) {
    Invoke-Step 'Build entry exe (cargo build + copy to repo root)' {
        Push-Location $SrcTauri
        try {
            cargo build
        } finally {
            Pop-Location
        }
        Copy-Item -Force (Join-Path $SrcTauri 'target\debug\dsh-gui.exe') (Join-Path $Root 'dsh-gui.exe')
    }
}

# 5) Plugins: build + install every package under plugins/ into the web profile.
Invoke-Step 'Build and install plugins under plugins/' {
    & (Join-Path $PSScriptRoot 'install-plugins.ps1')
}

Write-Host "`nDone. Entry exe: $Root\dsh-gui.exe" -ForegroundColor Green
Write-Host 'Create a desktop shortcut with: scripts\make-shortcut.ps1'
