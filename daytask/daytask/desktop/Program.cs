namespace DayTask.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var single = new SingleInstance();
        if (!single.IsOnlyInstance)
        {
            single.HandOverToRunningCopy(); // DayTask is already open: show that one instead
            return;
        }

        ApplicationConfiguration.Initialize();
        var window = new MainForm();
        single.ShowOnHandOver(window);
        Application.Run(window);
    }
}
