# Resizes Claude to one width and prints its top-row controls (debug aid for the placement test)
param([int]$W = 1250, [int]$X = 400, [int]$Y = 300, [int]$H = 1200)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; } }
"@
[D]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = (Get-Process claude | Where-Object { $_.MainWindowTitle -eq 'Claude' } | Select-Object -First 1).MainWindowHandle
$r0 = New-Object D+RECT; [D]::GetWindowRect($h, [ref]$r0) | Out-Null
[D]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, 0x14) | Out-Null
Start-Sleep 2
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
foreach ($d in $root.FindAll('Descendants', $cond)) { $v=''; try { $v = $d.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}; if ($v -like 'https://claude.ai/*') { $doc = $d } }
$dr = $doc.Current.BoundingRectangle; "doc $dr"
foreach ($e in $doc.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) { $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Top -lt $dr.Top - 2 -or $r.Top -gt $dr.Top + 30 -or $r.Height -gt 60) { continue }
  "{0,-12} x {1,5}..{2,5}  y {3,4}..{4,4}  '{5}'" -f $e.Current.ControlType.ProgrammaticName.Replace('ControlType.',''), [int]($r.Left-$dr.Left), [int]($r.Right-$dr.Left), [int]($r.Top-$dr.Top), [int]($r.Bottom-$dr.Top), $e.Current.Name }
[D]::SetWindowPos($h, [IntPtr]::Zero, $r0.L, $r0.T, $r0.R - $r0.L, $r0.B - $r0.T, 0x14) | Out-Null
