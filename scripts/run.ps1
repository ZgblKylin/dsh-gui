#Requires -Version 5.1
<#
.SYNOPSIS
  Run the built entry exe (build it first with scripts\setup.ps1).
#>
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Exe  = Join-Path $Root 'src-tauri\target\debug\dsh-gui.exe'

if (-not (Test-Path $Exe)) {
    throw "Entry exe not found at $Exe — run scripts\setup.ps1 first."
}

& $Exe
