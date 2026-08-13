#Requires -Version 5.1
<#
.SYNOPSIS
  Create a Windows shortcut to the dsh-gui entry exe.

.PARAMETER OutputPath
  Explicit .lnk path. Defaults to the current user's Desktop
  ("DeepSeek Harness.lnk").
#>
[CmdletBinding()]
param(
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Exe  = Join-Path $Root 'src-tauri\target\debug\dsh-gui.exe'

if (-not (Test-Path $Exe)) {
    throw "Entry exe not found at $Exe — run scripts\setup.ps1 first."
}

if (-not $OutputPath) {
    $OutputPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($OutputPath)
$link.TargetPath = $Exe
$link.WorkingDirectory = $Root
$link.Description = 'DeepSeek Harness (self-hosted webview)'
$link.IconLocation = "$Exe,0"
$link.Save()

Write-Host "Created shortcut: $OutputPath"
