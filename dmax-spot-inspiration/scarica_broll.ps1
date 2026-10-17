# Scarica tutti i reference con B-ROLL (broll_cli.py) in una cartella sul Desktop.
# Uso (PowerShell, dalla cartella dmax-spot-inspiration):
#   .\scarica_broll.ps1                       -> tutti i 72 video, divisi per sezione
#   .\scarica_broll.ps1 -Lista links-priorita.txt
#   .\scarica_broll.ps1 -Formato dnx          -> .mov edit-ready invece di mp4
param(
  [string]$Lista   = "links-tutti.txt",
  [string]$Formato = "mp4",
  [string]$Qualita = "1080",
  [string]$Cli     = "C:\Users\ezamb\Desktop\Claude Things\26_06_05 B-Roll - Youtube Downloader\B-ROLL_RELEASE\broll_cli.py",
  [string]$Dest    = (Join-Path ([Environment]::GetFolderPath("Desktop")) "D-Max Spot - Reference")
)
$ErrorActionPreference = "Continue"
if (-not (Test-Path $Cli)) { Write-Host "broll_cli.py non trovato: $Cli  (passa -Cli <percorso>)" -ForegroundColor Red; exit 1 }
$ListaPath = Join-Path $PSScriptRoot $Lista
$sezione = "Top 15"
$ok = 0; $ko = @()
foreach ($riga in Get-Content $ListaPath -Encoding UTF8) {
  $riga = $riga.Trim()
  if ($riga -match '^#\s*-+\s*(.+?)\s*-+\s*$') {
    # "# --- PICK-UP RECENTI ---" -> sottocartella "PICK-UP RECENTI"
    $sezione = ($Matches[1] -replace '[\\/:*?"<>|]', '').Trim()
    continue
  }
  if ($riga -notmatch '^https?://') { continue }
  $out = Join-Path $Dest $sezione
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  Write-Host "[$sezione] $riga" -ForegroundColor Cyan
  python "$Cli" $riga --out "$out" --format $Formato --quality $Qualita --json --quiet
  switch ($LASTEXITCODE) {
    0 { $ok++ }
    2 { Write-Host "Cookie YouTube scaduti: aggiorna cookies.txt nelle impostazioni di B-ROLL e rilancia." -ForegroundColor Yellow; exit 2 }
    3 { Write-Host "Strumenti B-ROLL mancanti: apri l'app B-ROLL una volta e rilancia." -ForegroundColor Yellow; exit 3 }
    default { $ko += $riga }
  }
}
Write-Host "`nScaricati: $ok  |  Falliti: $($ko.Count)  ->  $Dest" -ForegroundColor Green
if ($ko.Count) { $ko | Set-Content (Join-Path $Dest "falliti.txt"); Write-Host "Link falliti salvati in falliti.txt" }
