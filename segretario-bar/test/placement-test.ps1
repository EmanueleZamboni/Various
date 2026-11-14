# Placement test for Segretario Bar against the REAL Claude window (Ema asked for it, 14/11/2026).
# Resizes and moves the Claude window through many sizes, waits, then checks the bar against Claude's own top-row
# controls read through accessibility: same line, never on a control, visible when there is room. Saves a picture of
# the top row per case and restores the window at the end.
#   -Cases quick|full   -Out <folder for pictures + report>
param([string]$Cases = 'full', [string]$Out = "$env:TEMP\segbar-test", [int]$Wait = 4500, [string]$Links = '')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class T {
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 public struct RECT { public int L, T, R, B; } public struct POINT { public int X, Y; }
 public static List<IntPtr> Of(int pid) { var o = new List<IntPtr>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) o.Add(h); return true; }, IntPtr.Zero); return o; }
}
"@
[T]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

$claude = (Get-Process claude | Where-Object { $_.MainWindowTitle -eq 'Claude' } | Select-Object -First 1).MainWindowHandle
if (-not $claude) { throw 'Claude window not found' }
$wasMax = [T]::IsZoomed($claude)
$r0 = New-Object T+RECT; [T]::GetWindowRect($claude, [ref]$r0) | Out-Null
$s = [T]::GetDpiForWindow($claude) / 96.0

function BarWindow {
    $p = Get-Process SegretarioBar -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { return $null }
    foreach ($h in [T]::Of($p.Id)) {
        $r = New-Object T+RECT; [T]::GetWindowRect($h, [ref]$r) | Out-Null
        if ($r.B - $r.T -lt 300 -and $r.R - $r.L -gt 50) { return $h }   # the bar, not the login form
    }
}
function Client { $c = New-Object T+RECT; [T]::GetClientRect($claude, [ref]$c) | Out-Null; $p = New-Object T+POINT; [T]::ClientToScreen($claude, [ref]$p) | Out-Null
    [pscustomobject]@{ L = $p.X; T = $p.Y; R = $p.X + $c.R; B = $p.Y + $c.B } }

# Claude's top-row controls (the ground truth), from the claude.ai page
$docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
function TopRow {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($claude)
    $doc = $null
    foreach ($d in $root.FindAll('Descendants', $docCond)) { $v=''; try { $v = $d.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}; if ($v -like 'https://claude.ai/*') { $doc = $d; $url = $v } }
    if (-not $doc) { return $null }
    $dr = $doc.Current.BoundingRectangle
    $cr = New-Object System.Windows.Automation.CacheRequest
    $cr.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty); $cr.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty); $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
    $cr.TreeScope = 'Element'
    $act = $cr.Activate(); try { $all = $doc.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition) } finally { $act.Dispose() }
    $boxes = @()
    foreach ($e in $all) { $r = $e.Cached.BoundingRectangle
        if ($r.IsEmpty -or $r.Width -lt 6 -or $r.Height -lt 18 -or $r.Height -gt 56 -or $r.Top -lt $dr.Top -or $r.Top -gt $dr.Top + 14 -or $r.Width -gt $dr.Width * 0.5) { continue }
        $ct = $e.Cached.ControlType.ProgrammaticName.Replace('ControlType.', '')
        if ($ct -in 'Group','Pane','ToolBar','Custom','Document','List','ListItem','Text') { continue }   # visible controls only
        $boxes += [pscustomobject]@{ L = $r.Left; T = $r.Top; R = $r.Right; B = $r.Bottom; N = $e.Cached.Name; C = $ct } }
    # page content scrolling under the row is not part of it: keep the boxes on the line of the leftmost control
    $first = $boxes | Sort-Object L | Select-Object -First 1
    if ($first) { $boxes = @($boxes | Where-Object { [math]::Abs($_.T - $first.T) -le 3 -and [math]::Abs($_.B - $first.B) -le 3 }) }   # same top and bottom as Claude's own buttons
    [pscustomobject]@{ doc = $dr; url = $url; boxes = $boxes }
}
function Capture($x, $y, $w, $h, $file) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h)); $g.Dispose()
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

# cases: width x height at a position, in physical pixels (screen 3840x2160)
$list = @(
    @{ n = 'w1000';  x = 400; y = 300; w = 1000; h = 1200 },
    @{ n = 'w1250';  x = 400; y = 300; w = 1250; h = 1200 },
    @{ n = 'w1500';  x = 400; y = 300; w = 1500; h = 1200 },
    @{ n = 'w1800';  x = 300; y = 250; w = 1800; h = 1300 },
    @{ n = 'w2200';  x = 200; y = 200; w = 2200; h = 1400 },
    @{ n = 'w2800';  x = 100; y = 100; w = 2800; h = 1500 },
    @{ n = 'w3400';  x = 100; y = 100; w = 3400; h = 1800 },
    @{ n = 'low';    x = 900; y = 1100; w = 1700; h = 1000 },
    @{ n = 'right';  x = 2000; y = 400; w = 1800; h = 1200 },
    @{ n = 'max';    max = $true },
    @{ n = 'dragNarrow'; x = 300; y = 250; w = 1350; h = 1300; from = 2400 },   # a long drag of the right edge, inwards
    @{ n = 'dragWide';   x = 300; y = 250; w = 2600; h = 1300; from = 1200 },   # and outwards
    @{ n = 'w1600';  x = 500; y = 350; w = 1600; h = 1200 }
)
# -Links: no resizing, open each chat in turn (titles of different lengths, Code and normal chats)
if ($Links) { $list = @(); $i = 0; foreach ($l in ($Links -split ","))  { $list += @{ n = "chat$i"; link = $l }; $i++ } }
elseif ($Cases -eq 'quick') { $list = $list | Where-Object { $_.n -in 'w1250','w1800','w2800','max' } }

$report = @()
try {
    foreach ($c in $list) {
        if ($c.link) { Start-Process $c.link }
        elseif ($c.max) { [T]::ShowWindow($claude, 3) | Out-Null }
        else {
            if ([T]::IsZoomed($claude)) { [T]::ShowWindow($claude, 9) | Out-Null; Start-Sleep -Milliseconds 300 }
            if ($c.from) {
                # resizing by dragging the window's edge: 30 steps, 25 ms apart
                for ($i = 0; $i -le 30; $i++) { $w = [int]($c.from + ($c.w - $c.from) * $i / 30); [T]::SetWindowPos($claude, [IntPtr]::Zero, $c.x, $c.y, $w, $c.h, 0x14) | Out-Null; Start-Sleep -Milliseconds 25 }
            }
            # arrive the way a drag does: a few quick steps, then stop
            else { for ($i = 3; $i -ge 0; $i--) { [T]::SetWindowPos($claude, [IntPtr]::Zero, $c.x + $i * 60, $c.y + $i * 40, $c.w, $c.h, 0x14) | Out-Null; Start-Sleep -Milliseconds 40 } }
        }
        $verdicts = @()
        foreach ($when in 1200, $Wait) {   # once soon after the move, once settled
            Start-Sleep -Milliseconds ($when - $(if ($when -eq 1200) { 0 } else { 1200 }))
            $cl = Client; $row = TopRow; $bh = BarWindow
            $bar = $null; $vis = $false; $rg = $null
            if ($bh) { $b = New-Object T+RECT; [T]::GetWindowRect($bh, [ref]$b) | Out-Null; $vis = [T]::IsWindowVisible($bh)
                $rb = New-Object T+RECT; $kind = [T]::GetWindowRgnBox($bh, [ref]$rb)
                if ($kind -gt 1) { $rg = [pscustomobject]@{ L = $b.L + $rb.L; T = $b.T + $rb.T; R = $b.L + $rb.R; B = $b.T + $rb.B } }
                $bar = [pscustomobject]@{ L = $b.L; T = $b.T; R = $b.R; B = $b.B } }
            $problems = @()
            if (-not $row) { $problems += 'no claude.ai page found' }
            else {
                $btn = $row.boxes | Where-Object { $_.B - $_.T -ge 28 }
                $rowTop = ($btn | Measure-Object T -Minimum).Minimum; $rowBot = ($btn | Measure-Object B -Maximum).Maximum
                # free space: right of the last control of the left group, left of the first control of the right group
                $sorted = $row.boxes | Sort-Object L
                $gap = [math]::Max(60, 39 * 3); $edge = $row.doc.Left; $leftR = $edge
                foreach ($x in $sorted) { if ($x.L -gt $edge + $gap) { break }; $edge = [math]::Max($edge, $x.R) }
                $rightL = ($sorted | Where-Object { $_.L -gt $edge } | Measure-Object L -Minimum).Minimum
                if (-not $rightL) { $rightL = $cl.R - 140 * $s }
                $free = ($rightL - $edge) / $s
                if (-not $vis) { if ($free -ge 130) { $problems += "hidden although $([int]$free) css px are free" } }
                elseif (-not $rg) { $problems += 'visible but no shape' }
                else {
                    if ([math]::Abs($rg.T - $rowTop) -gt 4 -or [math]::Abs($rg.B - $rowBot) -gt 6) { $problems += "off the row line: bar $($rg.T)..$($rg.B), row $rowTop..$rowBot" }
                    if ($rg.T -lt $cl.T -or $rg.B -gt $cl.T + 70 * $s) { $problems += "NOT in the top row: bar at y $($rg.T), window top $($cl.T)" }
                    if ($rg.L -lt $cl.L -or $rg.R -gt $cl.R) { $problems += "sticks out of the window: bar $($rg.L)..$($rg.R), window $($cl.L)..$($cl.R)" }
                    foreach ($x in $row.boxes) { if ($x.R -gt $rg.L + 2 -and $x.L -lt $rg.R - 2 -and $x.B -gt $rg.T + 2 -and $x.T -lt $rg.B - 2 -and $x.C -notin 'Text','Group','Pane','ToolBar','Custom','Document','List','ListItem') { $problems += "covers '$($x.N)' ($($x.C) $([int]$x.L)..$([int]$x.R))"; break } }
                }
            }
            $verdicts += [pscustomobject]@{ at = $when; ok = ($problems.Count -eq 0); problems = ($problems -join '; '); bar = $rg; client = $cl; url = $(if ($row) { $row.url } else { '' }) }
        }
        $cl = Client
        Capture ([int]$cl.L) ([int]$cl.T) ([int][math]::Min(3840 - $cl.L, $cl.R - $cl.L)) ([int](60 * $s)) (Join-Path $Out "$($c.n).png")
        $report += [pscustomobject]@{ case = $c.n; soon = $verdicts[0].problems; settled = $verdicts[1].problems; ok = $verdicts[1].ok -and $verdicts[0].ok; url = $verdicts[1].url }
        "{0,-7} {1}  soon: {2}  settled: {3}" -f $c.n, $(if ($verdicts[1].ok -and $verdicts[0].ok) { 'OK  ' } else { 'FAIL' }), $(if ($verdicts[0].problems) { $verdicts[0].problems } else { 'ok' }), $(if ($verdicts[1].problems) { $verdicts[1].problems } else { 'ok' })
    }
}
finally {
    if ($wasMax) { [T]::ShowWindow($claude, 3) | Out-Null }
    else { if ([T]::IsZoomed($claude)) { [T]::ShowWindow($claude, 9) | Out-Null }; [T]::SetWindowPos($claude, [IntPtr]::Zero, $r0.L, $r0.T, $r0.R - $r0.L, $r0.B - $r0.T, 0x14) | Out-Null }
    $report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out 'report.json') -Encoding utf8
}
