namespace TingyiLite.Overlay;

public sealed record OverlayOptions(
    Uri Server,
    string? Token,
    int Lines,
    double FontSize,
    double Opacity,
    double Width,
    double Bottom,
    bool ClickThrough)
{
    public static OverlayOptions Parse(string[] args)
    {
        var values = ReadArgs(args);
        return new OverlayOptions(
            Server: ParseUri(values.GetValueOrDefault("server"), new Uri("http://127.0.0.1:8787/")),
            Token: ParseToken(values.GetValueOrDefault("token") ?? Environment.GetEnvironmentVariable("TINGYI_LOCAL_TOKEN")),
            Lines: Clamp(ParseInt(values.GetValueOrDefault("lines"), 3), 1, 5),
            FontSize: Clamp(ParseDouble(values.GetValueOrDefault("font-size"), 34), 22, 64),
            Opacity: Clamp(ParseDouble(values.GetValueOrDefault("opacity"), 0.78), 0.35, 0.95),
            Width: Clamp(ParseDouble(values.GetValueOrDefault("width"), 980), 320, 1800),
            Bottom: Clamp(ParseDouble(values.GetValueOrDefault("bottom"), 70), 0, 400),
            ClickThrough: ParseBool(values.GetValueOrDefault("click-through"), false));
    }

    private static Dictionary<string, string> ReadArgs(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index += 1)
        {
            var arg = args[index];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }
            var body = arg[2..];
            var equalsIndex = body.IndexOf('=');
            if (equalsIndex >= 0)
            {
                result[body[..equalsIndex]] = body[(equalsIndex + 1)..];
                continue;
            }
            if (string.Equals(body, "click-through", StringComparison.OrdinalIgnoreCase))
            {
                result[body] = "true";
                continue;
            }
            if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                result[body] = args[index + 1];
                index += 1;
            }
        }
        return result;
    }

    private static Uri ParseUri(string? value, Uri fallback)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            return fallback;
        }
        return uri.AbsolutePath.EndsWith("/", StringComparison.Ordinal) ? uri : new Uri(uri.AbsoluteUri.TrimEnd('/') + "/");
    }

    private static int ParseInt(string? value, int fallback) => int.TryParse(value, out var parsed) ? parsed : fallback;

    private static double ParseDouble(string? value, double fallback) => double.TryParse(value, out var parsed) ? parsed : fallback;

    private static bool ParseBool(string? value, bool fallback) => bool.TryParse(value, out var parsed) ? parsed : fallback;

    private static string? ParseToken(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static int Clamp(int value, int min, int max) => Math.Min(max, Math.Max(min, value));

    private static double Clamp(double value, double min, double max) => Math.Min(max, Math.Max(min, value));
}
