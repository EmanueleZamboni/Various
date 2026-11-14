# Reads Claude's top row N times and prints any control between the title and the right icons (debug aid)
param([int]$N = 12)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D2 { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
"@
[D2]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = (Get-Process claude | Where-Object { $_.MainWindowTitle -eq 'Claude' } | Select-Object -First 1).MainWindowHandle
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
for ($i = 0; $i -lt $N; $i++) {
  $doc = $null; foreach ($d in $root.FindAll('Descendants', $cond)) { $v=''; try { $v = $d.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}; if ($v -like 'https://claude.ai/*') { $doc = $d } }
  $dr = $doc.Current.BoundingRectangle; $out = @()
  foreach ($e in $doc.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) { $r = $e.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Top -lt $dr.Top - 2 -or $r.Top -gt $dr.Top + 20 -or $r.Height -gt 56 -or $r.Height -lt 18) { continue }
    $x = $r.Left - $dr.Left
    if ($x -gt 600 -and $x -lt $dr.Width - 600) { $out += "{0} {1}..{2} y{3}..{4} '{5}'" -f $e.Current.ControlType.ProgrammaticName.Replace('ControlType.',''), [int]$x, [int]($r.Right-$dr.Left), [int]($r.Top-$dr.Top), [int]($r.Bottom-$dr.Top), $e.Current.Name } }
  "[$i] doc w $([int]$dr.Width): " + ($out -join ' | ')
  Start-Sleep -Milliseconds 700
}
