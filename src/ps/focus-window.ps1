# Best-effort: bring an already-running session's console window to the foreground.
# Windows deliberately blocks background processes from stealing focus unless the
# calling thread recently processed user input — the simulated Alt press/release
# below is the standard, widely-used workaround for that restriction. This can
# still fail silently (or just flash the taskbar icon) depending on OS state;
# there is no guaranteed-reliable way to do this from a background service.
#
# .NET's Process.MainWindowHandle is unreliable for console windows in this
# environment (observed to return 0 for legitimate, visible console windows),
# so this enumerates top-level windows directly and matches by owning PID instead.
#
# On a machine where Windows Terminal is the default console host, EVERY new
# console launch becomes a tab inside one shared WindowsTerminal window rather
# than getting its own top-level window (verified: a fresh console process had
# no window of its own in a full window enumeration). In that case there is no
# way to target the exact tab from outside — Windows Terminal exposes no public
# API for it — so this falls back to focusing the shared WindowsTerminal window
# itself and reports that distinctly, rather than silently landing on the wrong
# tab with no explanation.

param([int]$TargetPid)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TrackerFocus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

function Find-WindowByPid([int]$targetProcId) {
    # NOTE: never name a parameter $pid — it shadows PowerShell's built-in
    # read-only automatic variable ($pid = the current process's own PID) and
    # fails at call time with "Cannot overwrite variable pid".
    #
    # NOTE: EnumWindows invokes this scriptblock as a native callback, not as a
    # normal nested call — it does not share this function's local scope. Both
    # the write (in the callback) and the read (after EnumWindows returns) must
    # use the same explicit $script: scope, or the match silently never
    # propagates back out (verified: using a function-local $result here
    # produced "window-not-found" even for a window that provably exists).
    $script:foundWindow = [IntPtr]::Zero
    $cb = {
        param($hWnd, $lParam)
        $procId = 0
        [void][TrackerFocus]::GetWindowThreadProcessId($hWnd, [ref]$procId)
        if ($procId -eq $targetProcId -and [TrackerFocus]::IsWindowVisible($hWnd)) {
            $script:foundWindow = $hWnd
            return $false
        }
        return $true
    }
    [void][TrackerFocus]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:foundWindow
}

# SetForegroundWindow's return value alone isn't trustworthy — Windows can report
# success while the foreground-lock restriction silently no-ops it. Verify by
# re-reading the actual foreground window afterward instead of taking the API's
# word for it.
function Focus-Window([IntPtr]$hWnd) {
    if ([TrackerFocus]::IsIconic($hWnd)) {
        [TrackerFocus]::ShowWindowAsync($hWnd, 9) | Out-Null  # SW_RESTORE
    }
    [TrackerFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)  # ALT down
    [TrackerFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)  # ALT up (KEYEVENTF_KEYUP)
    [TrackerFocus]::SetForegroundWindow($hWnd) | Out-Null
    Start-Sleep -Milliseconds 150
    return ([TrackerFocus]::GetForegroundWindow() -eq $hWnd)
}

$found = Find-WindowByPid $TargetPid
if ($found -ne [IntPtr]::Zero) {
    if (Focus-Window $found) {
        Write-Output "focused"
    } else {
        Write-Output "focus-blocked"
    }
    return
}

$wt = Get-Process -Name "WindowsTerminal" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($wt) {
    $wtWindow = Find-WindowByPid $wt.Id
    if ($wtWindow -ne [IntPtr]::Zero) {
        if (Focus-Window $wtWindow) {
            Write-Output "focused-terminal-fallback"
        } else {
            Write-Output "focus-blocked"
        }
        return
    }
}

Write-Output "window-not-found"
