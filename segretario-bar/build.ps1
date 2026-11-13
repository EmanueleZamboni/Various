# Builds Segretario Bar into .\dist with the C# compiler that ships with Windows (no SDK to install).
# The WebView2 libraries are Microsoft's own (SDK 1.0.1072, the .NET Framework build), copied from Microsoft's Teams
# Meeting add-in that is already on this PC, and checked to be signed by Microsoft before use. (The Logitech copy in
# Program Files is the .NET Core build and does not compile here.) They are not kept in git (dist\ is ignored).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dist = Join-Path $here 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$sdk = $env:WEBVIEW2_SDK_DIR
if (-not $sdk) {
    $sdk = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\TeamsMeetingAdd-in\*\x64" -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'Microsoft.Web.WebView2.WinForms.dll') } |
        Sort-Object { [version]$_.Parent.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $sdk) { throw "no WebView2 SDK folder found: set WEBVIEW2_SDK_DIR" }
foreach ($f in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') {
    $src = Join-Path $sdk $f
    if (-not (Test-Path $src)) { $src = Join-Path $sdk "runtimes\win-x64\native\$f" }
    $sig = Get-AuthenticodeSignature $src
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation') { throw "$f is not signed by Microsoft" }
    Copy-Item $src $dist -Force
}
foreach ($f in 'bar.html', 'bar.css', 'bar.js') { Copy-Item (Join-Path $here $f) $dist -Force }

$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
& "$fw\csc.exe" /nologo /target:winexe /platform:x64 /optimize+ /out:"$dist\SegretarioBar.exe" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll `
    /r:"$fw\WPF\UIAutomationClient.dll" /r:"$fw\WPF\UIAutomationTypes.dll" /r:"$fw\WPF\WindowsBase.dll" `
    /r:"$dist\Microsoft.Web.WebView2.Core.dll" /r:"$dist\Microsoft.Web.WebView2.WinForms.dll" `
    (Join-Path $here 'SegretarioBar.cs')
if ($LASTEXITCODE -ne 0) { throw "compile failed" }
Write-Output "built $dist\SegretarioBar.exe"
