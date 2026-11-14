# Stops the bar, rebuilds it, optionally runs a one-shot script outside Claude's sandbox, and starts it again
# (the bar must run outside the sandbox so it reads and writes the real %LOCALAPPDATA%\SegretarioBar).
param([string]$Also = '')
$ErrorActionPreference = 'Stop'
Stop-Process -Name SegretarioBar -Force -ErrorAction SilentlyContinue
Start-Sleep 2
& (Join-Path $PSScriptRoot '..\build.ps1')
function Outside($script) {
    schtasks /Create /TN "Segretario Bar oneshot" /TR "conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`"" /SC ONCE /ST 23:59 /SD 01/01/2030 /RL LIMITED /F | Out-Null
    schtasks /Run /TN "Segretario Bar oneshot" | Out-Null
    Start-Sleep 6
    schtasks /Delete /TN "Segretario Bar oneshot" /F | Out-Null
}
if ($Also) { Outside $Also }
Outside "C:\Users\ezamb\.claude\segretario-bar\install-outside.ps1"
for ($i = 0; $i -lt 20 -and -not (Get-Process SegretarioBar -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
Start-Sleep 12
"running: " + [bool](Get-Process SegretarioBar -ErrorAction SilentlyContinue)
