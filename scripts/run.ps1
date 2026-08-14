#Requires -Version 5.1
<#
.SYNOPSIS
  Launch the entry exe like a regular Win32 GUI app: the terminal returns
  immediately and stays usable (build it first with scripts\setup.ps1).
#>
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Exe  = Join-Path $Root 'dsh-gui.exe'

if (-not (Test-Path $Exe)) {
    # Pre-root-copy layout or a manual `cargo build` in src-tauri: fall back
    # to the cargo output (scripts\build.ps1 refreshes the root copy).
    $Exe = Join-Path $Root 'src-tauri\target\debug\dsh-gui.exe'
    if (-not (Test-Path $Exe)) {
        throw "Entry exe not found at $Root\dsh-gui.exe — run scripts\setup.ps1 first."
    }
    Write-Warning 'Using the cargo-built exe; scripts\build.ps1 refreshes dsh-gui.exe at the repo root.'
}

# Start-Process detaches the launch: PowerShell returns at once, and closing
# the terminal never kills dsh-gui (or its harness child).
Start-Process -FilePath $Exe -WorkingDirectory $Root