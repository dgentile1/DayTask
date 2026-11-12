using System.Runtime.InteropServices;

namespace DayTask.Desktop;

/// <summary>
/// Keeps one DayTask running per signed-in user. Because the window lives in the tray and is
/// often minimized, a second launch — the desktop shortcut double-clicked while it is already
/// running — doesn't just quit: it asks the copy already running to come to the front, so it
/// looks like the shortcut worked rather than like nothing happened.
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    // Local\ (the default) scopes these to the signed-in user's session, so two people using the
    // same computer each get their own DayTask.
    private const string MutexName = "DayTask.Desktop.SingleInstance";
    private const string EventName = "DayTask.Desktop.SingleInstance.Show";

    private const int AnyProcess = -1; // ASFW_ANY

    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int processId);

    private readonly Mutex _mutex;
    private readonly EventWaitHandle _show;
    private RegisteredWaitHandle? _waiting;

    /// <summary>False when DayTask is already running for this user.</summary>
    public bool IsOnlyInstance { get; }

    public SingleInstance()
    {
        // Not owned: the name is held for as long as this process keeps the handle open, which is
        // all that is being asked, and there is then no ownership to abandon if DayTask crashes.
        _mutex = new Mutex(false, MutexName, out var createdNew);
        IsOnlyInstance = createdNew;
        _show = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
    }

    /// <summary>Bring the copy already running to the front, then let this launch end.</summary>
    public void HandOverToRunningCopy()
    {
        // Windows blocks a background process from taking the foreground unless the process being
        // replaced says it may; this launch is the foreground one, so it can give that permission.
        AllowSetForegroundWindow(AnyProcess);
        _show.Set();
    }

    /// <summary>Show <paramref name="window"/> whenever another launch hands over to this one.</summary>
    public void ShowOnHandOver(MainForm window) =>
        _waiting = ThreadPool.RegisterWaitForSingleObject(_show, (_, _) =>
        {
            // Signalled from a thread pool thread; the window may also be closing by now.
            if (window is { IsDisposed: false, IsHandleCreated: true })
                window.BeginInvoke(window.ShowWindow);
        }, null, Timeout.Infinite, false);

    public void Dispose()
    {
        _waiting?.Unregister(null);
        _mutex.Dispose();
        _show.Dispose();
    }
}
