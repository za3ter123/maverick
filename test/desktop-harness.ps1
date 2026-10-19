param([string]$Keys = '^+4', [string]$Shot = '', [int]$WaitMs = 8000)
# Test harness only (not an app feature). Opens a plain window that stands in for Teams, makes it the
# foreground window, sends one key chord with SendKeys, waits, then screenshots the primary screen.
# Keys go only to this window: if it is not in front, nothing is sent.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  public static void Force(IntPtr h) {
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(me, fg, false);
  }
  public static string Title() { var sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, 512); return sb.ToString(); }
}
"@
[Fg]::SetProcessDPIAware() | Out-Null
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Other app (test harness) - has focus'
$f.Width = 760; $f.Height = 300; $f.StartPosition = 'Manual'; $f.Left = 580; $f.Top = 640
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true; $tb.Dock = 'Fill'; $tb.Font = New-Object System.Drawing.Font('Segoe UI', 14)
$tb.Text = "This window stands in for Teams and has keyboard focus. SendKeys sends $Keys to it."
$f.Controls.Add($tb)
$script:log = @()
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 1500
$script:step = 0
$t.Add_Tick({
  $script:step++
  if ($script:step -eq 1) {
    [Fg]::Force($f.Handle); $f.Activate(); $tb.Focus() | Out-Null; Start-Sleep -Milliseconds 300
    $title = [Fg]::Title()
    $script:log += "foreground before: $title"
    if ($title -ne $f.Text) { $script:log += 'ABORT: harness window not in front, no keys sent'; $f.Close(); return }
    $before = $tb.Text
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    $script:log += "sent $Keys at $((Get-Date).ToString('HH:mm:ss.fff'))"
    $script:log += "foreground after: $([Fg]::Title())"
    $script:log += "harness text unchanged (the chord never reached this app): $($tb.Text -eq $before)"
    $t.Interval = $WaitMs
  } else {
    $script:log += "foreground at screenshot: $([Fg]::Title())"
    if ($Shot) {
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size); $bmp.Save($Shot); $g.Dispose(); $bmp.Dispose()
      $script:log += "saved $Shot"
    }
    $t.Stop(); $f.Close()
  }
})
$f.Add_Shown({ $f.Activate(); $t.Start() })
[System.Windows.Forms.Application]::Run($f)
$script:log | ForEach-Object { Write-Output $_ }
