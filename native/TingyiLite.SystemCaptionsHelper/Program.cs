using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace TingyiLite.SystemCaptionsHelper;

internal static partial class Program
{
    private const string ProcessName = "LiveCaptions";
    private const string WindowClassName = "LiveCaptionsDesktopWindow";
    private const string CaptionsTextBlockAutomationId = "CaptionsTextBlock";
    private const string ReadyTextBlockAutomationId = "ReadyToCaptionTextBlock";
    private const int DefaultStartupTimeoutMs = 12000;
    private const int DefaultPollIntervalMs = 100;
    private const int MaximumPollIntervalMs = 1000;
    private const int StreamReconnectTimeoutMs = 750;
    private const int StreamUnavailableTimeoutMs = DefaultStartupTimeoutMs;
    private const int CaptionTextLimit = 500;
    private const int MinimumLiveCaptionsWindowsBuild = 22621;

    private static AutomationElement? window;
    private static AutomationElement? captionsTextBlock;

    private readonly record struct CaptionReadResult(bool Available, string Text, string? Error);

    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        if (HasFlag(args, "--self-test"))
        {
            return RunSelfTest();
        }
        if (HasFlag(args, "--probe"))
        {
            return RunProbe(ParseInt(args, "--timeout-ms", DefaultStartupTimeoutMs));
        }
        if (HasFlag(args, "--version"))
        {
            WriteJson(new { type = "version", ok = true, helper = "tingyi-lite-system-captions", protocol = "caption-jsonl-v2" });
            return 0;
        }

        return RunCaptionStream(args);
    }

    private static int RunCaptionStream(string[] args)
    {
        var timeoutMs = ParseInt(args, "--timeout-ms", DefaultStartupTimeoutMs);
        var pollIntervalMs = Math.Clamp(ParseInt(args, "--poll-ms", DefaultPollIntervalMs), 80, MaximumPollIntervalMs);
        var language = ParseString(args, "--language", "en");
        try
        {
            EnsureSupportedOperatingSystem();
            EnsureLiveCaptionsReady(TimeSpan.FromMilliseconds(timeoutMs));
            WriteJson(new { type = "status", ok = true, status = "ready", helper = "tingyi-lite-system-captions" });
        }
        catch (Exception ex)
        {
            WriteJson(new
            {
                type = "status",
                ok = false,
                status = "unavailable",
                helper = "tingyi-lite-system-captions",
                error = ex.Message
            });
            return 1;
        }

        var stopwatch = Stopwatch.StartNew();
        var stabilizer = new CaptionSnapshotStabilizer();
        var previewPublisher = new CaptionPreviewPublisher();
        var liveness = new CaptionStreamLivenessTracker(StreamUnavailableTimeoutMs);
        var initialRead = ReadCaptionText();
        if (initialRead.Available)
        {
            stabilizer.Initialize(initialRead.Text, stopwatch.ElapsedMilliseconds);
        }
        var stopRequested = Task.Run(() => Console.In.ReadLine());
        while (!stopRequested.IsCompleted)
        {
            var read = ReadCaptionText();
            var endMs = stopwatch.ElapsedMilliseconds;
            var livenessTransition = liveness.Observe(read.Available, endMs);
            if (!read.Available)
            {
                WriteCaption(stabilizer.Interrupt(endMs), language);
                WritePreview(previewPublisher.Update(null), language);
                if (livenessTransition == CaptionStreamLivenessTransition.Reconnecting)
                {
                    WriteJson(new
                    {
                        type = "status",
                        ok = true,
                        status = "reconnecting",
                        helper = "tingyi-lite-system-captions",
                        error = read.Error
                    });
                }
                else if (livenessTransition == CaptionStreamLivenessTransition.Unavailable)
                {
                    WriteJson(new
                    {
                        type = "status",
                        ok = false,
                        status = "unavailable",
                        helper = "tingyi-lite-system-captions",
                        error = $"Windows Live Captions remained unavailable for {StreamUnavailableTimeoutMs} ms: {read.Error ?? "UI Automation binding is unavailable."}"
                    });
                    return 1;
                }
            }
            else
            {
                if (livenessTransition == CaptionStreamLivenessTransition.Ready)
                {
                    WriteJson(new { type = "status", ok = true, status = "ready", helper = "tingyi-lite-system-captions" });
                    stabilizer.Initialize(read.Text, endMs);
                    WritePreview(previewPublisher.Update(null), language);
                }
                else
                {
                    WriteCaption(stabilizer.Observe(read.Text, endMs), language);
                    WritePreview(previewPublisher.Update(stabilizer.CurrentPreview(endMs)), language);
                }
            }
            Thread.Sleep(pollIntervalMs);
        }

        var drainDeadlineMs = stopwatch.ElapsedMilliseconds + CaptionSnapshotStabilizer.DefaultStableForMs;
        while (stopwatch.ElapsedMilliseconds < drainDeadlineMs)
        {
            var read = ReadCaptionText(allowReconnect: false);
            var nowMs = stopwatch.ElapsedMilliseconds;
            if (!read.Available)
            {
                WriteCaption(stabilizer.Interrupt(nowMs), language);
                WritePreview(previewPublisher.Update(null), language);
            }
            else
            {
                WriteCaption(stabilizer.Observe(read.Text, nowMs), language);
                WritePreview(previewPublisher.Update(stabilizer.CurrentPreview(nowMs)), language);
            }
            Thread.Sleep(pollIntervalMs);
        }
        WriteCaption(stabilizer.Flush(stopwatch.ElapsedMilliseconds), language);
        WritePreview(previewPublisher.Update(null), language);
        return 0;
    }

    private static void WriteCaption(CaptionEmission? caption, string language)
    {
        if (caption is null)
        {
            return;
        }
        WriteJson(new
        {
            type = "caption",
            text = caption.Text,
            startMs = caption.StartMs,
            endMs = caption.EndMs,
            language,
            isFinal = true
        });
    }

    private static void WritePreview(CaptionPreviewTransition? preview, string language)
    {
        if (preview is null)
        {
            return;
        }
        if (preview.Action == CaptionPreviewAction.Clear)
        {
            WriteJson(new
            {
                type = "caption.preview",
                action = "clear",
                revision = preview.Revision
            });
            return;
        }
        WriteJson(new
        {
            type = "caption.preview",
            action = "upsert",
            revision = preview.Revision,
            text = preview.Caption!.Text,
            startMs = preview.Caption.StartMs,
            endMs = preview.Caption.EndMs,
            language
        });
    }

    private static int RunSelfTest()
    {
        try
        {
            var stabilizerCases = CaptionSnapshotStabilizer.RunDeterministicSelfTest();
            var previewCases = CaptionPreviewPublisher.RunDeterministicSelfTest();
            var livenessCases = CaptionStreamLivenessTracker.RunDeterministicSelfTest();
            WriteJson(new
            {
                type = "self_test",
                ok = true,
                helper = "tingyi-lite-system-captions",
                protocol = "caption-jsonl-v2",
                automationElementType = typeof(AutomationElement).FullName,
                liveCaptionsProcessName = ProcessName,
                liveCaptionsWindowClassName = WindowClassName,
                captionsTextBlockAutomationId = CaptionsTextBlockAutomationId,
                readyTextBlockAutomationId = ReadyTextBlockAutomationId,
                stabilizerCases,
                previewCases,
                livenessCases
            });
            return 0;
        }
        catch (Exception ex)
        {
            WriteJson(new { type = "self_test", ok = false, helper = "tingyi-lite-system-captions", error = ex.Message });
            return 1;
        }
    }

    private static int RunProbe(int timeoutMs)
    {
        try
        {
            EnsureSupportedOperatingSystem();
            EnsureLiveCaptionsReady(TimeSpan.FromMilliseconds(timeoutMs));
            WriteJson(new
            {
                type = "probe",
                ok = true,
                helper = "tingyi-lite-system-captions",
                liveCaptionsProcessName = ProcessName,
                liveCaptionsWindowClassName = WindowClassName,
                captionsTextBlockAutomationId = CaptionsTextBlockAutomationId,
                readyTextBlockAutomationId = ReadyTextBlockAutomationId,
                timeoutMs
            });
            return 0;
        }
        catch (Exception ex)
        {
            WriteJson(new
            {
                type = "probe",
                ok = false,
                helper = "tingyi-lite-system-captions",
                error = ex.Message,
                timeoutMs
            });
            return 1;
        }
    }

    private static void EnsureSupportedOperatingSystem()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, MinimumLiveCaptionsWindowsBuild))
        {
            throw new InvalidOperationException(
                $"Windows Live Captions requires Windows 11 22H2 or newer (build {MinimumLiveCaptionsWindowsBuild}+). Current OS build is {Environment.OSVersion.Version.Build}.");
        }
    }

    private static CaptionReadResult ReadCaptionText(bool allowReconnect = true)
    {
        try
        {
            if (window != null)
            {
                var currentWindow = FindLiveCaptionsWindow();
                if (currentWindow == null || !Automation.Compare(window, currentWindow))
                {
                    ResetLiveCaptionsBinding();
                }
                else
                {
                    window = currentWindow;
                }
            }
            if (window == null)
            {
                if (!allowReconnect)
                {
                    return new CaptionReadResult(false, "", "Windows Live Captions is disconnected during shutdown drain.");
                }
                EnsureLiveCaptionsReady(TimeSpan.FromMilliseconds(StreamReconnectTimeoutMs));
            }
            captionsTextBlock = FindElementByAutomationId(window!, CaptionsTextBlockAutomationId);
            return new CaptionReadResult(true, TrimCaptionWindowText(captionsTextBlock?.Current.Name ?? ""), null);
        }
        catch (ElementNotAvailableException ex)
        {
            ResetLiveCaptionsBinding();
            return new CaptionReadResult(false, "", ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            ResetLiveCaptionsBinding();
            return new CaptionReadResult(false, "", ex.Message);
        }
    }

    private static void ResetLiveCaptionsBinding()
    {
        window = null;
        captionsTextBlock = null;
    }

    private static void EnsureLiveCaptionsReady(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        Exception? lastError = null;
        while (DateTime.UtcNow <= deadline)
        {
            try
            {
                window ??= FindLiveCaptionsWindow();
                if (window == null)
                {
                    LaunchLiveCaptions();
                    Thread.Sleep(300);
                    continue;
                }

                captionsTextBlock ??= FindElementByAutomationId(window, CaptionsTextBlockAutomationId);
                if (captionsTextBlock != null || FindElementByAutomationId(window, ReadyTextBlockAutomationId) != null)
                {
                    return;
                }
            }
            catch (Exception ex)
            {
                lastError = ex;
                window = null;
                captionsTextBlock = null;
            }
            Thread.Sleep(200);
        }

        throw new InvalidOperationException(lastError == null
            ? "Windows Live Captions is not available or its ready/caption text element was not found."
            : $"Windows Live Captions is not available: {lastError.Message}");
    }

    private static AutomationElement? FindLiveCaptionsWindow()
    {
        foreach (var process in Process.GetProcessesByName(ProcessName))
        {
            try
            {
                var condition = new PropertyCondition(AutomationElement.ProcessIdProperty, process.Id);
                var candidate = AutomationElement.RootElement.FindFirst(TreeScope.Children, condition);
                if (candidate != null && string.Equals(candidate.Current.ClassName, WindowClassName, StringComparison.Ordinal))
                {
                    return candidate;
                }
            }
            catch
            {
                // Try the next LiveCaptions process.
            }
        }
        return null;
    }

    private static AutomationElement? FindElementByAutomationId(AutomationElement root, string automationId)
    {
        var condition = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
        return root.FindFirst(TreeScope.Descendants, condition);
    }

    private static void LaunchLiveCaptions()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = ProcessName,
            UseShellExecute = true
        });
    }

    private static string TrimCaptionWindowText(string text)
    {
        var normalized = WhitespacePattern().Replace(text, " ").Trim();
        if (normalized.Length <= CaptionTextLimit)
        {
            return normalized;
        }

        var tail = normalized[^CaptionTextLimit..];
        var firstBoundary = tail.IndexOfAny(['.', '?', '!', '。', '？', '！']);
        return firstBoundary >= 0 && firstBoundary + 1 < tail.Length
            ? tail[(firstBoundary + 1)..].Trim()
            : tail.Trim();
    }

    private static bool HasFlag(string[] args, string name) => args.Any(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));

    private static int ParseInt(string[] args, string name, int fallback)
    {
        for (var index = 0; index < args.Length - 1; index += 1)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase) && int.TryParse(args[index + 1], out var parsed))
            {
                return parsed;
            }
        }
        return fallback;
    }

    private static string ParseString(string[] args, string name, string fallback)
    {
        for (var index = 0; index < args.Length - 1; index += 1)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(args[index + 1]))
            {
                return args[index + 1];
            }
        }
        return fallback;
    }

    private static void WriteJson(object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value));
        Console.Out.Flush();
    }

    [GeneratedRegex("\\s+")]
    private static partial Regex WhitespacePattern();
}

internal enum CaptionPreviewAction
{
    Upsert,
    Clear
}

internal sealed record CaptionPreviewTransition(
    CaptionPreviewAction Action,
    long Revision,
    CaptionEmission? Caption);

internal sealed class CaptionPreviewPublisher
{
    private string? activeText;
    private long revision;

    internal CaptionPreviewTransition? Update(CaptionEmission? preview)
    {
        if (preview is null)
        {
            if (activeText is null)
            {
                return null;
            }
            activeText = null;
            return new CaptionPreviewTransition(CaptionPreviewAction.Clear, ++revision, null);
        }
        if (string.Equals(activeText, preview.Text, StringComparison.Ordinal))
        {
            return null;
        }
        activeText = preview.Text;
        return new CaptionPreviewTransition(CaptionPreviewAction.Upsert, ++revision, preview);
    }

    internal static int RunDeterministicSelfTest()
    {
        var cases = 0;

        var stabilizer = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        var publisher = new CaptionPreviewPublisher();
        stabilizer.Initialize("", 0);
        stabilizer.Observe("Mister And", 100);
        AssertPreview("Mister And", CaptionPreviewAction.Upsert, 1, publisher.Update(stabilizer.CurrentPreview(100)));
        stabilizer.Observe("Mister Anderson", 200);
        AssertPreview("Mister Anderson", CaptionPreviewAction.Upsert, 2, publisher.Update(stabilizer.CurrentPreview(200)));
        stabilizer.Observe("Mister Anderson", 300);
        AssertPreview(null, null, null, publisher.Update(stabilizer.CurrentPreview(300)));
        var stabilized = stabilizer.Observe("Mister Anderson", 950);
        AssertCaption("Mister Anderson", stabilized);
        AssertPreview(null, CaptionPreviewAction.Clear, 3, publisher.Update(stabilizer.CurrentPreview(950)));
        cases += 1;

        stabilizer = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        publisher = new CaptionPreviewPublisher();
        stabilizer.Initialize("", 0);
        stabilizer.Observe("one", 100);
        publisher.Update(stabilizer.CurrentPreview(100));
        stabilizer.Observe("one two", 600);
        publisher.Update(stabilizer.CurrentPreview(600));
        stabilizer.Observe("one two three", 1200);
        publisher.Update(stabilizer.CurrentPreview(1200));
        var overdue = stabilizer.Observe("one two three four", 2100);
        AssertCaption("one two three", overdue);
        AssertPreview("four", CaptionPreviewAction.Upsert, 4, publisher.Update(stabilizer.CurrentPreview(2100)));
        cases += 1;

        stabilizer = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        publisher = new CaptionPreviewPublisher();
        stabilizer.Initialize("", 0);
        stabilizer.Observe("transient tail", 100);
        AssertPreview("transient tail", CaptionPreviewAction.Upsert, 1, publisher.Update(stabilizer.CurrentPreview(100)));
        stabilizer.Observe("", 200);
        AssertPreview(null, CaptionPreviewAction.Clear, 2, publisher.Update(stabilizer.CurrentPreview(200)));
        stabilizer.Observe("transient tail", 300);
        AssertPreview("transient tail", CaptionPreviewAction.Upsert, 3, publisher.Update(stabilizer.CurrentPreview(300)));
        cases += 1;

        stabilizer = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        publisher = new CaptionPreviewPublisher();
        stabilizer.Initialize("old lesson", 0);
        stabilizer.Observe("", 100);
        stabilizer.Observe("", 850);
        stabilizer.Observe("lesson starts now", 900);
        AssertPreview("lesson starts now", CaptionPreviewAction.Upsert, 1, publisher.Update(stabilizer.CurrentPreview(900)));
        cases += 1;

        stabilizer = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        publisher = new CaptionPreviewPublisher();
        stabilizer.Initialize("the bakery at three before the sun was up", 0);
        stabilizer.Observe("the bakery at 3:00 AM while everyone prepared the ovens", 100);
        AssertPreview(
            "the bakery at 3:00 AM while everyone prepared the ovens",
            CaptionPreviewAction.Upsert,
            1,
            publisher.Update(stabilizer.CurrentPreview(100)));
        cases += 1;

        stabilizer = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        publisher = new CaptionPreviewPublisher();
        stabilizer.Initialize("", 0);
        stabilizer.Observe("final tail", 100);
        AssertPreview("final tail", CaptionPreviewAction.Upsert, 1, publisher.Update(stabilizer.CurrentPreview(100)));
        AssertCaption("final tail", stabilizer.Flush(250));
        AssertPreview(null, CaptionPreviewAction.Clear, 2, publisher.Update(stabilizer.CurrentPreview(250)));
        AssertPreview(null, null, null, publisher.Update(null));
        cases += 1;

        return cases;
    }

    private static void AssertCaption(string expectedText, CaptionEmission? actual)
    {
        if (actual is null || !string.Equals(expectedText, actual.Text, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Caption preview self-test expected final '{expectedText}', got '{actual?.Text ?? "<null>"}'.");
        }
    }

    private static void AssertPreview(
        string? expectedText,
        CaptionPreviewAction? expectedAction,
        long? expectedRevision,
        CaptionPreviewTransition? actual)
    {
        if (expectedAction is null)
        {
            if (actual is not null)
            {
                throw new InvalidOperationException("Caption preview self-test expected no transition.");
            }
            return;
        }
        if (actual is null
            || actual.Action != expectedAction
            || actual.Revision != expectedRevision
            || !string.Equals(actual.Caption?.Text, expectedText, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Caption preview self-test expected {expectedAction} revision {expectedRevision} text '{expectedText ?? "<null>"}'.");
        }
    }
}
