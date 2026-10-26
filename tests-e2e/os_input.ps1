# Real OS input for the e2e tests (what CDP can't do: a drag that leaves the window, the clipboard).
#   os_input.ps1 drag <x0> <y0> <x1> <y1>      press at (x0,y0), move to (x1,y1) slowly, release (screen px)
#   os_input.ps1 droptarget <x> <y> <log>        a window that accepts dropped files and writes their paths to <log>
#   os_input.ps1 clipboard                       prints the files on the clipboard, one per line
param([string]$cmd, [string]$a, [string]$b, [string]$c, [string]$d)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QgInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public const uint DOWN = 0x02, UP = 0x04;
}
"@
[QgInput]::SetProcessDPIAware() | Out-Null

switch ($cmd) {
  "drag" {
    $x0 = [int]$a; $y0 = [int]$b; $x1 = [int]$c; $y1 = [int]$d
    [QgInput]::SetCursorPos($x0, $y0) | Out-Null; Start-Sleep -Milliseconds 250
    [QgInput]::mouse_event([QgInput]::DOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 150
    for ($i = 1; $i -le 40; $i++) {
      $x = [int]($x0 + ($x1 - $x0) * $i / 40); $y = [int]($y0 + ($y1 - $y0) * $i / 40)
      [QgInput]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 35
    }
    Start-Sleep -Milliseconds 400
    [QgInput]::mouse_event([QgInput]::UP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  "click" {
    [QgInput]::SetCursorPos([int]$a, [int]$b) | Out-Null; Start-Sleep -Milliseconds 120
    [QgInput]::mouse_event([QgInput]::DOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
    [QgInput]::mouse_event([QgInput]::UP, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 300
  }
  "droptarget" {
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.Form
    $f.Text = "QG drop target"; $f.TopMost = $true; $f.AllowDrop = $true
    $f.StartPosition = "Manual"; $f.Left = [int]$a; $f.Top = [int]$b; $f.Width = 320; $f.Height = 260
    $f.BackColor = [System.Drawing.Color]::DarkSlateBlue
    $log = $c
    $f.Add_DragEnter({ param($s, $e) if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $e.Effect = "Copy" } })
    $f.Add_DragDrop({ param($s, $e) $files = $e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop); Set-Content -Path $log -Value ($files -join "`n") -Encoding UTF8 })
    $f.Add_Shown({ Set-Content -Path "$log.ready" -Value "1" })
    [System.Windows.Forms.Application]::Run($f)
  }
  "front" {
    # bring the main window of process <pid> to the front (ALT tap lets SetForegroundWindow work)
    $p = Get-Process -Id ([int]$a)
    $h = $p.MainWindowHandle
    [QgInput]::ShowWindow($h, 9) | Out-Null
    [QgInput]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [QgInput]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [QgInput]::SetForegroundWindow($h) | Out-Null
    # raise it above everything (topmost on, then off again): works even when focus can't be taken
    [QgInput]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0013) | Out-Null
    [QgInput]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0013) | Out-Null
    [QgInput]::SetForegroundWindow($h) | Out-Null
    $r = New-Object QgInput+RECT
    [QgInput]::GetWindowRect($h, [ref]$r) | Out-Null
    Write-Output "$($r.L) $($r.T) $($r.R) $($r.B)"
  }
  "owner" {
    # the process owning the top-level window at screen point (x, y)
    $pt = New-Object QgInput+POINT; $pt.X = [int]$a; $pt.Y = [int]$b
    $w = [QgInput]::GetAncestor([QgInput]::WindowFromPoint($pt), 2)
    $p = Get-Process | Where-Object { $_.MainWindowHandle -eq $w } | Select-Object -First 1
    if ($p) { Write-Output $p.Id } else { Write-Output "0 $w" }
  }
  "clipboard" {
    Add-Type -AssemblyName System.Windows.Forms
    $l = [System.Windows.Forms.Clipboard]::GetFileDropList()
    foreach ($p in $l) { Write-Output $p }
  }
}
