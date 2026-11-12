using System.Text.Json;

namespace DayTask.Desktop;

/// <summary>Where the web app lives. Read from desktop.json next to the exe.</summary>
internal static class DesktopConfig
{
    public static string LoadAppUrl()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "desktop.json");
        try
        {
            if (File.Exists(path))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                if (doc.RootElement.TryGetProperty("appUrl", out var url) && !string.IsNullOrWhiteSpace(url.GetString()))
                    return url.GetString()!;
            }
        }
        catch (JsonException) { /* fall through to default */ }
        return Environment.GetEnvironmentVariable("DAYTASK_URL") ?? "http://localhost:5173/";
    }
}

/// <summary>Per-machine window state: always-on-top, position and max width. %APPDATA%\DayTask\desktop-state.json</summary>
internal sealed class DesktopState
{
    public bool TopMost { get; set; }
    /// <summary>Widest the page content may get, in CSS pixels. Null means the default.</summary>
    public int? MaxWidth { get; set; }
    public int? X { get; set; }
    public int? Y { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    /// <summary>
    /// The screen scaling the bounds above were measured at (96 is 100%), so they can be resized
    /// if the window reopens somewhere scaled differently. Null for state saved before 1.2.0.
    /// </summary>
    public int? Dpi { get; set; }

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DayTask", "desktop-state.json");

    public static DesktopState Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<DesktopState>(File.ReadAllText(FilePath)) ?? new DesktopState();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { }
        return new DesktopState();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}
