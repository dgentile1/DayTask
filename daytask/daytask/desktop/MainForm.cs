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

    public MainForm()
    {
        Text = "DayTask";
        MinimumSize = new Size(320, 420);
        StartPosition = FormStartPosition.Manual;
        Bounds = InitialBounds();
        TopMost = _state.TopMost;
        UpdateTitle();
        Controls.Add(_web);

        // Tray icon: carries the daily due-date notification and brings the window back.
        _tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        _tray.BalloonTipClicked += (_, _) => ShowWindow();
        _tray.DoubleClick += (_, _) => ShowWindow();
        FormClosed += (_, _) => _tray.Dispose();

        Load += async (_, _) => await InitWebViewAsync();
        FormClosing += (_, _) => SaveBounds();
    }

    private Rectangle InitialBounds()
    {
        if (_state is { X: { } x, Y: { } y, Width: { } w, Height: { } h })
        {
            var saved = new Rectangle(x, y, w, h);
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(saved))) return saved;
        }
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        return new Rectangle(area.Right - 420, area.Top + 40, 400, Math.Min(760, area.Height - 80));
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
        core.AcceleratorKeyPressed += OnAcceleratorKey;
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true; // open links in the normal browser, not a second WebView window
            Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
        };
        core.Navigate(_appUrl);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess) { PostTopMost(); return; }
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
                case "hello": PostTopMost(); break;
                case "notify":
                    ShowNotification(
                        doc.RootElement.TryGetProperty("title", out var t) ? t.GetString() : null,
                        doc.RootElement.TryGetProperty("body", out var b) ? b.GetString() : null);
                    break;
            }
        }
        catch (JsonException) { /* ignore malformed messages */ }
    }

    private void OnAcceleratorKey(object? sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
    {
        // Ctrl+Shift+T toggles always-on-top even while the web view has focus.
        if (e.KeyEventKind == CoreWebView2KeyEventKind.KeyDown &&
            e.VirtualKey == (uint)Keys.T &&
            (ModifierKeys & (Keys.Control | Keys.Shift)) == (Keys.Control | Keys.Shift))
        {
            e.Handled = true;
            SetTopMost(!TopMost);
        }
    }

    private void SetTopMost(bool value)
    {
        TopMost = value;
        _state.TopMost = value;
        _state.Save();
        UpdateTitle();
        PostTopMost();
    }

    private void PostTopMost() =>
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "topMost", value = TopMost }));

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
        _state.Save();
    }
}
