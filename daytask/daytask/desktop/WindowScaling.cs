using System.Runtime.InteropServices;

namespace DayTask.Desktop;

/// <summary>
/// The parts of per-monitor scaling WinForms doesn't do for us.
///
/// WinForms resizes a PerMonitorV2 window by itself when the screen's scaling changes, taking the
/// rectangle Windows suggests. That is the right size while the window is on screen. It is not
/// after an undock with DayTask put away: nothing is said until the window is restored, and the
/// suggestion is then the taskbar placeholder's size, about 160x28, which would leave the window
/// as small as its minimum allows. These helpers let <see cref="MainForm"/> recognise that case
/// and size the window itself, and answer the size limits per screen rather than holding them in
/// Form.MinimumSize/MaximumSize.
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

    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] private static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromRect(ref Rect rect, int flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AdjustWindowRectExForDpi(ref Rect rect, int style, bool hasMenu, int exStyle, int dpi);
    [DllImport("Shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out int dpiX, out int dpiY);

    /// <summary>Put a rectangle back as the window's restored size, pulled inside the screen it lands on.</summary>
    public static void SetRestoreBounds(IntPtr window, Rectangle bounds)
    {
        var placement = Placement.Empty;
        if (!GetWindowPlacement(window, ref placement)) return;
        // NormalPosition is in workspace coordinates, which only differ from the screen
        // coordinates ClampToWorkingArea uses when the taskbar is docked top or left.
        placement.NormalPosition = new Rect(ClampToWorkingArea(bounds));
        SetWindowPlacement(window, ref placement); // leaves ShowCmd alone, so a minimized window stays minimized
    }

    /// <summary>
    /// Whether the size Windows suggests with a DPI change is the one it gets by scaling the
    /// window, give or take rounding. It isn't once the window has been minimized: the suggestion
    /// is worked out from the taskbar placeholder (about 160x28) and stays that way even after the
    /// window is back at its real size, so taking it shrinks the window to the smallest it may be.
    /// </summary>
    public static bool LooksScaled(Size suggested, Size wanted)
    {
        static bool Near(int a, int b) => Math.Abs(a - b) <= Math.Max(8, b / 10);
        return Near(suggested.Width, wanted.Width) && Near(suggested.Height, wanted.Height);
    }

    /// <summary>The same rectangle's size at a different screen scaling, top-left kept.</summary>
    public static Rectangle ScaleSize(Rectangle bounds, int oldDpi, int newDpi)
    {
        if (oldDpi <= 0 || newDpi <= 0) return bounds;
        var scale = (float)newDpi / oldDpi;
        return new Rectangle(
            bounds.X, bounds.Y,
            (int)Math.Round(bounds.Width * scale),
            (int)Math.Round(bounds.Height * scale));
    }

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
