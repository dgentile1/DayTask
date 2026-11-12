using System.Runtime.InteropServices;

namespace DayTask.Desktop;

/// <summary>
/// The parts of per-monitor scaling WinForms doesn't do for us.
///
/// WinForms resizes a PerMonitorV2 window by itself when the screen's scaling changes, but only
/// while the window is on screen. If the message arrives while the window is minimized — DayTask
/// put away, then the laptop undocked — it takes the new scaling and leaves the window's size
/// alone, so the window comes back at the old screen's pixel size and stays there. These helpers
/// let <see cref="MainForm"/> size the window itself, for that case and for the size limits,
/// which have to be answered per screen rather than held in Form.MinimumSize/MaximumSize.
/// </summary>
internal static class WindowScaling
{
    public const int WmDpiChanged = 0x02E0;
    public const int WmGetMinMaxInfo = 0x0024;

    private const int MonitorDefaultToNearest = 2;
    private const int EffectiveDpi = 0; // MDT_EFFECTIVE_DPI: what the user picked in Display settings

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
        public Rect(Rectangle r) => (Left, Top, Right, Bottom) = (r.Left, r.Top, r.Right, r.Bottom);
    }

    /// <summary>The limits Windows passes with WM_GETMINMAXINFO, all in pixels.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Placement
    {
        public int Length, Flags, ShowCmd;
        public Point MinPosition, MaxPosition;
        public Rect NormalPosition;

        public static Placement Empty => new() { Length = Marshal.SizeOf<Placement>() };
    }

    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] private static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromRect(ref Rect rect, int flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AdjustWindowRectExForDpi(ref Rect rect, int style, bool hasMenu, int exStyle, int dpi);
    [DllImport("Shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out int dpiX, out int dpiY);

    /// <summary>
    /// True while the window isn't showing at its normal size, so WinForms will skip rescaling it
    /// and whatever size it is remembering for the restore has to be corrected by hand.
    /// </summary>
    public static bool IsMinimizedOrMaximized(IntPtr window) => IsIconic(window) || IsZoomed(window);

    /// <summary>
    /// Narrow the limits Windows is about to size the window by. It asks for these immediately
    /// before every resize — a drag, a maximize, or a restore from the tray — so answering the
    /// question each time is what keeps them right across a change of screen. Holding the same
    /// numbers in Form.MinimumSize and Form.MaximumSize instead means they are whatever the last
    /// screen needed at the moment Windows restores the window, which clamps it to the wrong size.
    /// </summary>
    public static void LimitTrackSize(IntPtr minMaxInfo, Size minimum, int maximumWidth)
    {
        var info = Marshal.PtrToStructure<MinMaxInfo>(minMaxInfo);
        info.MinTrackSize = new Point(
            Math.Max(info.MinTrackSize.X, minimum.Width),
            Math.Max(info.MinTrackSize.Y, minimum.Height));
        // Width only: the window may be as tall as Windows is willing to let it be. MaxTrackSize
        // caps a maximized window too, so this keeps the cap when the title bar is double-clicked.
        info.MaxTrackSize = new Point(
            Math.Max(Math.Min(info.MaxTrackSize.X, maximumWidth), info.MinTrackSize.X),
            info.MaxTrackSize.Y);
        Marshal.StructureToPtr(info, minMaxInfo, false);
    }

    /// <summary>
    /// Resize the rectangle Windows is holding for the window's restored size, as if the window
    /// had been open on the new screen all along, then pull it inside that screen.
    /// </summary>
    public static void ScaleRestoreBounds(IntPtr window, int oldDpi, int newDpi)
    {
        var placement = Placement.Empty;
        if (oldDpi <= 0 || newDpi <= 0 || !GetWindowPlacement(window, ref placement)) return;

        var current = placement.NormalPosition;
        var scale = (float)newDpi / oldDpi;
        var scaled = new Rectangle(
            current.Left, current.Top,
            (int)Math.Round((current.Right - current.Left) * scale),
            (int)Math.Round((current.Bottom - current.Top) * scale));

        // NormalPosition is in workspace coordinates, which only differ from the screen
        // coordinates ClampToWorkingArea uses when the taskbar is docked top or left.
        placement.NormalPosition = new Rect(ClampToWorkingArea(scaled));
        SetWindowPlacement(window, ref placement); // leaves ShowCmd alone, so it stays minimized
    }

    /// <summary>Shrink and shift a window rectangle until it fits the screen it is nearest to.</summary>
    public static Rectangle ClampToWorkingArea(Rectangle bounds)
    {
        var area = Screen.FromRectangle(bounds).WorkingArea;
        var width = Math.Min(bounds.Width, area.Width);
        var height = Math.Min(bounds.Height, area.Height);
        return new Rectangle(
            Math.Clamp(bounds.X, area.Left, area.Right - width),
            Math.Clamp(bounds.Y, area.Top, area.Bottom - height),
            width, height);
    }

    /// <summary>The scaling of the screen a rectangle is on, as a DPI (96 is 100%).</summary>
    public static int DpiForRect(Rectangle bounds)
    {
        var rect = new Rect(bounds);
        var monitor = MonitorFromRect(ref rect, MonitorDefaultToNearest);
        return monitor != IntPtr.Zero && GetDpiForMonitor(monitor, EffectiveDpi, out var dpi, out _) == 0 ? dpi : 96;
    }

    /// <summary>
    /// How much wider the window is than the page inside it — the two side borders — at a given
    /// scaling. Asking Windows means this is right even when the window is minimized, where
    /// measuring it as Width minus ClientSize.Width reads 237 and 0 and so gives nonsense.
    /// </summary>
    public static int FrameWidth(int style, int exStyle, int dpi)
    {
        var rect = new Rect(new Rectangle(0, 0, 100, 100));
        if (AdjustWindowRectExForDpi(ref rect, style, false, exStyle, dpi))
            return Math.Max(0, (rect.Right - rect.Left) - 100);
        return (int)Math.Ceiling(16 * dpi / 96f); // it failed: assume a plain sizing border
    }
}
