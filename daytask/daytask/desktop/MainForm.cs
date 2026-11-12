using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DayTask.Desktop;

/// <summary>
/// Thin always-on-top window around the DayTask web app.
/// The web UI and all task logic are shared with the phone; this shell only adds
/// window behaviour (TopMost, remembered position) and a message bridge.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly DesktopState _state = DesktopState.Load();
    private readonly string _appUrl = DesktopConfig.LoadAppUrl();
    private readonly NotifyIcon _tray = new() { Text = "DayTask", Visible = true };
    private readonly ToolStripMenuItem _topMenuItem = new("Always on top");

    // The page's content is at most 640px wide by default (#app in web/styles.css); the window
    // may be at most this much wider, so it never opens up empty space beside the list.
    // Settings > Desktop can change the content width on this computer (saved in DesktopState).
    private const int ContentMaxWidth = 640;
    private const int ExtraWidth = 16;
    internal const int MinContentWidth = 400;
    internal const int MaxContentWidth = 1600;

    // Smallest useful window, at 100% scaling; SizeLimits sizes these for the current screen.
    private const int MinWidth = 320;
    private const int MinHeight = 420;

    private int ContentWidth => Math.Clamp(_state.MaxWidth ?? ContentMaxWidth, MinContentWidth, MaxContentWidth);

    /// <summary>
    /// "1.1.0 (abc1234)": &lt;Version&gt; from the .csproj plus the git commit the build added,
    /// and "Debug" for a build run from Visual Studio, so a test build is easy to tell apart.
    /// </summary>
    internal static readonly string AppVersion = BuildVersion();

    private static string BuildVersion()
    {
        var info = typeof(MainForm).Assembly
            .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion
            ?? Application.ProductVersion;
        var plus = info.IndexOf('+');
        var version = plus < 0 ? info : info[..plus];
        var details = new List<string>();
        if (plus >= 0) details.Add(info[(plus + 1)..][..Math.Min(7, info.Length - plus - 1)]);
#if DEBUG
        details.Add("Debug");
#endif
        return details.Count == 0 ? version : $"{version} ({string.Join(", ", details)})";
    }

    public MainForm()
    {
        Text = "DayTask";
        Icon = AppIcon(null);
        StartPosition = FormStartPosition.Manual;
        Bounds = InitialBounds();
        TopMost = _state.TopMost;
        UpdateTitle();
        Controls.Add(_web);
        // How big the window may be, and what happens when the screen's scaling changes (moved
        // to another monitor, docked, undocked), are both handled in WndProc.

        // Tray icon: carries the daily due-date notification and brings the window back.
        // Right-click: version / Always on top / Show DayTask / Exit.
        _tray.Icon = AppIcon(SystemInformation.SmallIconSize);
        _tray.Text = $"DayTask {AppVersion}"; // hover text (Windows allows up to 127 characters)
        _tray.BalloonTipClicked += (_, _) => ShowWindow();
        _tray.DoubleClick += (_, _) => ShowWindow();
        _topMenuItem.Checked = TopMost;
        _topMenuItem.Click += (_, _) => SetTopMost(!TopMost);
        var menu = new ContextMenuStrip();
        menu.Items.Add(new ToolStripMenuItem($"DayTask desktop {AppVersion}") { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_topMenuItem);
        menu.Items.Add("Show DayTask", null, (_, _) => ShowWindow());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => Close());
        _tray.ContextMenuStrip = menu;
        FormClosed += (_, _) => _tray.Dispose();

        Load += (_, _) => ApplyWidthCap(); // once the real window (and its scaling) exists
        Load += async (_, _) => await InitWebViewAsync();
        FormClosing += (_, _) => SaveBounds();
    }

    /// <summary>
    /// How big the window may be on the screen it is on now: at most the content's maximum width
    /// plus a little, so it never opens up empty space beside the list, and at least a usable
    /// window. Height is left to Windows.
    /// </summary>
    private (Size Minimum, int MaximumWidth) SizeLimits()
    {
        var scale = DeviceDpi / 96f;
        var minimum = new Size((int)Math.Round(MinWidth * scale), (int)Math.Round(MinHeight * scale));
        var frame = WindowScaling.FrameWidth(CreateParams.Style, CreateParams.ExStyle, DeviceDpi);
        var maxWidth = (int)Math.Ceiling((ContentWidth + ExtraWidth) * scale) + frame;
        return (minimum, Math.Max(maxWidth, minimum.Width));
    }

    /// <summary>
    /// Pull the window in if it is wider than it may be — after the content width is changed in
    /// Settings, or a move to a screen that scales down. Windows applies the cap itself for
    /// anything it drives (a drag, a maximize, a restore) via WM_GETMINMAXINFO below.
    /// </summary>
    private void ApplyWidthCap()
    {
        if (IsDisposed || !IsHandleCreated || WindowState != FormWindowState.Normal) return;
        var (_, maxWidth) = SizeLimits();
        if (Width > maxWidth) Width = maxWidth;
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            // Asked right before Windows sizes the window, so the answer is always for the screen
            // it is sizing it on. Form.MinimumSize/MaximumSize can't do this job: they hold the
            // last screen's numbers at the moment a window is restored onto a new one, and clamp
            // it to those — and WinForms rescales both again after a DPI change, on top of
            // whatever we set, which turned the 640px width cap into a 1280px one at 200%.
            case WindowScaling.WmGetMinMaxInfo when IsHandleCreated:
            {
                base.WndProc(ref m);
                var (minimum, maxWidth) = SizeLimits();
                WindowScaling.LimitTrackSize(m.LParam, minimum, maxWidth);
                return;
            }

            // The screen's scaling changed: moved to another monitor, or the monitors themselves
            // changed by docking or undocking.
            case WindowScaling.WmDpiChanged:
            {
                var oldDpi = DeviceDpi;
                var newDpi = (int)((long)m.WParam & 0xFFFF); // LOWORD: the new screen's scaling
                // WinForms resizes the window for the new screen only if it is on screen at the
                // time. Minimized — DayTask put away, then the laptop undocked — it takes the new
                // scaling and leaves the size alone, so the window comes back at the old screen's
                // pixel size: two thirds the size at 150%, half at 200%. It never catches up
                // either, because the notification Windows repeats once the window is back matches
                // DeviceDpi by then and counts as no change. Resize it ourselves in that case.
                var resizeOurselves = WindowScaling.IsMinimizedOrMaximized(Handle);
                base.WndProc(ref m);
                if (resizeOurselves && newDpi > 0 && newDpi != oldDpi)
                    WindowScaling.ScaleRestoreBounds(Handle, oldDpi, newDpi);
                if (IsHandleCreated) BeginInvoke(ApplyWidthCap);
                return;
            }

            default:
                base.WndProc(ref m);
                return;
        }
    }

    /// <summary>
    /// The app icon, shared with the web app (icon.svg — rendered to icon.ico). Pass the size the
    /// caller needs so the matching frame is used rather than a resize of the wrong one.
    /// </summary>
    private static Icon AppIcon(Size? size)
    {
        using var stream = typeof(MainForm).Assembly.GetManifestResourceStream("DayTask.Desktop.icon.ico");
        if (stream is null) return SystemIcons.Application; // resource dropped from the build
        return size is { } s ? new Icon(stream, s) : new Icon(stream);
    }

    /// <summary>
    /// Where to open: last session's window, resized if the screen it lands on is scaled
    /// differently than the one it was closed on — shut on a docked 100% monitor and reopened on
    /// a 150% laptop screen, the same pixel count is two thirds the window — and pulled inside
    /// that screen. Otherwise a strip down the right of the main screen.
    /// </summary>
    private Rectangle InitialBounds()
    {
        if (_state is { X: { } x, Y: { } y, Width: { } w, Height: { } h })
        {
            var saved = new Rectangle(x, y, w, h);
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(saved)))
            {
                // The saved bounds are plain pixels; _state.Dpi is the scaling they were taken at.
                var dpi = WindowScaling.DpiForRect(saved);
                if (_state.Dpi is > 0 and var savedDpi && savedDpi != dpi)
                    saved.Size = new Size(
                        (int)Math.Round(saved.Width * (float)dpi / savedDpi),
                        (int)Math.Round(saved.Height * (float)dpi / savedDpi));
                return WindowScaling.ClampToWorkingArea(saved);
            }
        }
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        var scale = WindowScaling.DpiForRect(area) / 96f;
        var size = new Size((int)Math.Round(400 * scale), (int)Math.Round(760 * scale));
        var margin = (int)Math.Round(20 * scale);
        return WindowScaling.ClampToWorkingArea(
            new Rectangle(area.Right - size.Width - margin, area.Top + margin * 2, size.Width, size.Height));
    }

    private async Task InitWebViewAsync()
    {
        try
        {
            // Own profile folder so the sign-in session persists between launches.
            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DayTask", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "DayTask needs the Microsoft Edge WebView2 Runtime. Install it from Microsoft, then start DayTask again.",
                "WebView2 Runtime missing", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += OnNavigationCompleted;
        // Ctrl+Shift+T toggles always-on-top. The WinForms wrapper doesn't surface
        // CoreWebView2Controller.AcceleratorKeyPressed, so the page reports the key instead.
        await core.AddScriptToExecuteOnDocumentCreatedAsync("""
            addEventListener('keydown', e => {
                if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') {
                    e.preventDefault();
                    chrome.webview.postMessage({ type: 'toggleTopMost' });
                }
            }, true);
            """);
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true; // open links in the normal browser, not a second WebView window
            Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
        };
        core.Navigate(_appUrl);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess) { PostTopMost(); PostMaxWidth(); PostShell(); return; }
        var url = System.Net.WebUtility.HtmlEncode(_appUrl);
        _web.CoreWebView2.NavigateToString($"""
            <html><body style="font-family:Segoe UI,sans-serif;padding:24px;color:#16202A">
            <h2>Can't reach DayTask</h2>
            <p>Couldn't load {url} ({e.WebErrorStatus}).</p>
            <p>Check your connection or the appUrl in desktop.json.</p>
            <button onclick="location.href='{url}'" style="font-size:16px;padding:6px 14px">Try again</button>
            </body></html>
            """);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            if (!doc.RootElement.TryGetProperty("type", out var type)) return;
            switch (type.GetString())
            {
                case "toggleTopMost": SetTopMost(!TopMost); break;
                case "hello": PostTopMost(); PostMaxWidth(); PostShell(); break;
                case "setMaxWidth":
                    if (doc.RootElement.TryGetProperty("value", out var v) && v.TryGetInt32(out var px)) SetMaxWidth(px);
                    break;
                case "notify":
                    ShowNotification(
                        doc.RootElement.TryGetProperty("title", out var t) ? t.GetString() : null,
                        doc.RootElement.TryGetProperty("body", out var b) ? b.GetString() : null);
                    break;
            }
        }
        catch (JsonException) { /* ignore malformed messages */ }
    }

    private void SetTopMost(bool value)
    {
        TopMost = value;
        _topMenuItem.Checked = value;
        _state.TopMost = value;
        _state.Save();
        UpdateTitle();
        PostTopMost();
    }

    private void PostTopMost() =>
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "topMost", value = TopMost }));

    /// <summary>Save the content width for this computer, re-cap the window and tell the page.</summary>
    private void SetMaxWidth(int value)
    {
        var px = Math.Clamp(value, MinContentWidth, MaxContentWidth);
        _state.MaxWidth = px == ContentMaxWidth ? null : px; // the default stays unset, so a new default applies
        _state.Save();
        ApplyWidthCap();
        PostMaxWidth();
    }

    /// <summary>Tell the page which shell build it's running in (Settings > About).</summary>
    private void PostShell() =>
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "shell", version = AppVersion }));

    private void PostMaxWidth() =>
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            type = "maxWidth", value = ContentWidth, min = MinContentWidth, max = MaxContentWidth, @default = ContentMaxWidth,
        }));

    private void ShowNotification(string? title, string? body)
    {
        static string Clip(string? s, int max) =>
            string.IsNullOrWhiteSpace(s) ? " " : (s.Length <= max ? s : s[..(max - 1)] + "…");
        // Windows 10/11 show this as a toast; title and text have length limits.
        _tray.ShowBalloonTip(10_000, Clip(title ?? "DayTask", 60), Clip(body, 250), ToolTipIcon.Info);
    }

    private void ShowWindow()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
    }

    private void UpdateTitle() => Text = TopMost ? "DayTask (on top)" : "DayTask";

    private void SaveBounds()
    {
        var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        (_state.X, _state.Y, _state.Width, _state.Height) = (b.X, b.Y, b.Width, b.Height);
        _state.Dpi = DeviceDpi; // the scaling those pixels were measured at
        _state.Save();
    }
}
