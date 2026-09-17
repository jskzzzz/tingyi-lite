using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                throw new PlatformNotSupportedException("WASAPI render loopback requires Windows.");
            }

            Dictionary<string, string> options = ParseOptions(args);
            int segmentDurationMs = ParsePositiveInteger(options, "segment-ms");
            int sampleRateHz = ParsePositiveInteger(options, "sample-rate-hz");
            if (sampleRateHz < 8000 || sampleRateHz > 96000)
            {
                throw new ArgumentOutOfRangeException(nameof(sampleRateHz), "sample-rate-hz must be between 8000 and 96000.");
            }

            TingyiWasapiRenderLoopback.CaptureStream(segmentDurationMs, sampleRateHz);
            return 0;
        }
        catch (Exception exception)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { @event = "failed", error = exception.Message }));
            Console.Out.Flush();
            return 1;
        }
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        if (args.Length == 0 || args.Length % 2 != 0)
        {
            throw new ArgumentException("Expected --segment-ms and --sample-rate-hz.");
        }

        Dictionary<string, string> options = new(StringComparer.Ordinal);
        for (int index = 0; index < args.Length; index += 2)
        {
            string key = args[index];
            if (!key.StartsWith("--", StringComparison.Ordinal) || !options.TryAdd(key[2..], args[index + 1]))
            {
                throw new ArgumentException("Invalid or duplicate option: " + key);
            }
        }

        if (options.Count != 2 || !options.ContainsKey("segment-ms") || !options.ContainsKey("sample-rate-hz"))
        {
            throw new ArgumentException("Expected only --segment-ms and --sample-rate-hz.");
        }
        return options;
    }

    private static int ParsePositiveInteger(IReadOnlyDictionary<string, string> options, string key)
    {
        if (!int.TryParse(options[key], out int value) || value <= 0)
        {
            throw new ArgumentException(key + " must be a positive integer.");
        }
        return value;
    }
}
