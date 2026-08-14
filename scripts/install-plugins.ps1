#Requires -Version 5.1
<#
.SYNOPSIS
  Build and install every plugin package under plugins/ into the web profile.

.DESCRIPTION
  Each subdirectory of plugins/ that holds a package.json is treated as a
  plugin package. For each one this script:
    1. runs `pnpm install --store-dir .pnpm-store` + `pnpm run build` inside
       the plugin directory (repo-local store, pinned toolchain pnpm),
    2. installs it into the web profile with
       `dsh plugin --profile web add link:<plugin>` so $DSH_HOME/.dsh/profiles/web
       carries it as a dependency (DSH_HOME is pinned to the repository's .dsh),
       and
    3. mounts it into the web composition by appending an `insert` entry to
       the profile's cordis.patch.yml (entry id from the plugin's
       `dsh.gui.mountId` declaration, else the package name minus a leading
       `dsh-`). Restart dsh-gui afterwards for the composition to reload.

  Invoked automatically by scripts\setup.ps1 and scripts\build.ps1 after the
  entry exe has been built; also runnable standalone.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Toolchain = Join-Path $Root '.toolchain'
$Store     = Join-Path $Root '.pnpm-store'
$Harness   = Join-Path $Root 'deepseek-harness'
$Plugins   = Join-Path $Root 'plugins'
$WebHome   = Join-Path $Root '.dsh'

$PnpmShim = Join-Path $Toolchain 'pnpm.cmd'
if (-not (Test-Path $PnpmShim)) {
    throw "pnpm is not bootstrapped yet — run scripts\setup.ps1 once."
}

$DshBin = Join-Path $Harness 'apps\cli\lib\bin.js'
if (-not (Test-Path $DshBin)) {
    throw "the harness CLI is not built yet ($DshBin missing) — run scripts\setup.ps1 once."
}

$pluginDirs = @(
    Get-ChildItem -Path $Plugins -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
)

if ($pluginDirs.Count -eq 0) {
    Write-Host 'No plugin packages under plugins/ — nothing to build or install.'
    return
}

Write-Host "`n==> build plugin packages" -ForegroundColor Cyan
foreach ($plugin in $pluginDirs) {
    Write-Host "--- build $($plugin.Name)" -ForegroundColor Cyan
    Push-Location $plugin.FullName
    try {
        $env:CI = 'true'  # skip dev-only git-hook setup, like the harness steps
        & $PnpmShim install --store-dir $Store
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed for plugin $($plugin.Name) (exit $LASTEXITCODE)" }
        & $PnpmShim run build
        if ($LASTEXITCODE -ne 0) { throw "pnpm run build failed for plugin $($plugin.Name) (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

Write-Host "`n==> install plugins into the web profile" -ForegroundColor Cyan
# `dsh plugin` forwards to `pnpm` on PATH; prepend the pinned toolchain so the
# compatible pnpm (11.7.0) is used no matter which system pnpm is installed.
$env:PATH = "$Toolchain;$env:PATH"
$env:DSH_HOME = $WebHome

# Pin the profile's pnpm store. `dsh plugin` runs pnpm with the profile as cwd
# and without --store-dir; pnpm >=10 reads its settings from
# pnpm-workspace.yaml, and the unset default store resolves from the invoking
# environment's home variables, which differ between a plain terminal and the
# desktop shell. Without the pin, an install made from one context fails the
# other with ERR_PNPM_UNEXPECTED_STORE. Force the repo-local store so every
# invocation agrees with how the profile was installed.
$profileDir = Join-Path $WebHome 'profiles\web'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$workspacePath = Join-Path $profileDir 'pnpm-workspace.yaml'
if (-not (Test-Path $workspacePath)) {
    # Mirror the harness's profile template (hoisted linker, no auto peers) so
    # a fresh profile installs the way the harness expects.
    [System.IO.File]::WriteAllText(
        $workspacePath,
        "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
}
$storeLine = "storeDir: '$($Store.Replace("'", "''"))'"
$workspaceLines = @(Get-Content $workspacePath | Where-Object { $_ -notmatch '^\s*storeDir\s*:' })
while ($workspaceLines.Count -gt 0 -and $workspaceLines[-1] -eq '') {
    $workspaceLines = $workspaceLines[0..($workspaceLines.Count - 2)]
}
[System.IO.File]::WriteAllText(
    $workspacePath,
    (($workspaceLines + '' + $storeLine) -join "`n") + "`n",
    (New-Object System.Text.UTF8Encoding($false))
)

foreach ($plugin in $pluginDirs) {
    Write-Host "--- install $($plugin.Name)" -ForegroundColor Cyan
    & node $DshBin plugin --profile web add "link:$($plugin.FullName)"
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed for plugin $($plugin.Name) (exit $LASTEXITCODE)" }
}

# Mount every plugin into the web composition. `dsh plugin add` only records
# the dependency; the harness scans the Loader's ENTRIES for `dsh.client`
# declarations, so a plugin stays inert until a cordis.patch.yml insert turns
# it into an entry (the "mount" step the plugin READMEs describe). The entry
# id comes from the plugin's `dsh.gui.mountId` declaration, or is derived from
# the package name by stripping a leading `dsh-`.
Write-Host "`n==> mount plugins into the web composition" -ForegroundColor Cyan
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $patchPath)) {
    # Mirror the harness's profile patch template.
    [System.IO.File]::WriteAllLines(
        $patchPath,
        @(
            '# Your patch layer for this dsh profile, applied after every bundle layer:',
            '# a top-level YAML array of loader patch entries (id-targeted config',
            '# overrides, disables, and insert lists; `!!js` expressions allowed).',
            '[]'
        ),
        (New-Object System.Text.UTF8Encoding($false))
    )
}
$patchText = [System.IO.File]::ReadAllText($patchPath)

$mounts = [System.Collections.Generic.List[object]]::new()
foreach ($plugin in $pluginDirs) {
    $manifest = Get-Content (Join-Path $plugin.FullName 'package.json') -Raw | ConvertFrom-Json
    $pkgName = [string]$manifest.name
    $mountId = $null
    $dshProp = $manifest.PSObject.Properties['dsh']
    if ($null -ne $dshProp) {
        $guiProp = $dshProp.Value.PSObject.Properties['gui']
        if ($null -ne $guiProp) {
            $mountProp = $guiProp.Value.PSObject.Properties['mountId']
            if ($null -ne $mountProp) { $mountId = [string]$mountProp.Value }
        }
    }
    if ([string]::IsNullOrWhiteSpace($mountId)) {
        $mountId = $pkgName -replace '^dsh-', ''
        Write-Host "  mount id for $($plugin.Name) derived as '$mountId' from its package name (declare `"dsh.gui.mountId`" in its package.json to override)" -ForegroundColor DarkGray
    }
    if (-not ($mounts | Where-Object { $_.Id -eq $mountId -and $_.Name -eq $pkgName })) {
        $mounts.Add([PSCustomObject]@{ Id = $mountId; Name = $pkgName })
    }
}

# Idempotent append: only mounts whose canonical insert block is not already
# present are added; the default `[]` body is replaced by the first insert.
$toWrite = [System.Collections.Generic.List[string]]::new()
$written = [System.Collections.Generic.List[object]]::new()
foreach ($mount in $mounts) {
    $re = '(?ms)^\s*-\s*insert\s*:\s*$[^\r\n]*\r?\n[^\r\n]*-\s*id:\s*' `
        + [regex]::Escape($mount.Id) + '[^\r\n]*\r?\n[^\r\n]*name:\s*' `
        + [regex]::Escape($mount.Name) + '\s*$'
    if (-not [regex]::IsMatch($patchText, $re)) {
        $toWrite.Add("- insert:`n    - id: $($mount.Id)`n      name: $($mount.Name)")
        $written.Add($mount)
    }
}
if ($toWrite.Count -gt 0) {
    $blocks = ($toWrite | ForEach-Object { $_ }) -join "`n"
    $body = @($patchText -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#|^\s*$' }) -join "`n"
    if ($body.Trim() -eq '[]') {
        $head = @($patchText -split "`r?`n" | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }) -join "`n"
        $newText = $head.TrimEnd() + "`n" + $blocks + "`n"
    } else {
        $newText = $patchText.TrimEnd() + "`n" + $blocks + "`n"
    }
    [System.IO.File]::WriteAllText($patchPath, $newText, (New-Object System.Text.UTF8Encoding($false)))
    foreach ($mount in $written) {
        Write-Host "  mounted $($mount.Name) as entry '$($mount.Id)'" -ForegroundColor Cyan
    }
} else {
    Write-Host '  all plugins already mounted' -ForegroundColor DarkGray
}

Write-Host "`nDone. Plugins built and installed into $WebHome\profiles\web." -ForegroundColor Green
Write-Host 'Restart dsh-gui for the composition to reload and the plugins to appear.'
