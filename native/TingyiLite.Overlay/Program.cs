using System.Windows;

namespace TingyiLite.Overlay;

public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.Ordinal))
        {
            OverlaySelfTest.Run();
            return;
        }

        var options = OverlayOptions.Parse(args);
        using var cancellation = new CancellationTokenSource();
        var client = new LiteCaptionClient(options.Server, options.Lines, options.Token);
        var window = new OverlayWindow(options);
        client.SnapshotChanged += window.UpdateSnapshot;
        window.Closed += (_, _) => cancellation.Cancel();
        window.Loaded += (_, _) => _ = Task.Run(() => client.RunAsync(cancellation.Token));

        var app = new Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose
        };
        app.Run(window);
    }
}
