using System.Text.RegularExpressions;

namespace TingyiLite.SystemCaptionsHelper;

internal sealed record CaptionEmission(string Text, long StartMs, long EndMs);

internal sealed partial class CaptionSnapshotStabilizer
{
    internal const int DefaultStableForMs = 750;
    internal const int DefaultMaxPendingMs = 2000;
    internal const int MaximumCaptionCharacters = 120;

    private const int MinimumInteriorOverlapTokens = 4;
    private const int MaximumRevisedTailTokens = 3;
    private const int MaximumRevisedTailCharacters = 80;

    private readonly int stableForMs;
    private readonly int maxPendingMs;
    private string baseline = "";
    private string lastObserved = "";
    private long lastObservedSinceMs;
    private long? pendingSinceMs;
    private bool initialized;
    private bool observationInterrupted;
    private bool resetAuthorized;
    private long? emptySinceMs;
    private long? unavailableSinceMs;

    internal CaptionSnapshotStabilizer(
        int stableForMs = DefaultStableForMs,
        int maxPendingMs = DefaultMaxPendingMs)
    {
        if (stableForMs < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(stableForMs));
        }
        if (maxPendingMs < stableForMs)
        {
            throw new ArgumentOutOfRangeException(nameof(maxPendingMs));
        }
        this.stableForMs = stableForMs;
        this.maxPendingMs = maxPendingMs;
    }

    internal void Initialize(string snapshot, long nowMs)
    {
        baseline = NormalizeSnapshot(snapshot);
        lastObserved = baseline;
        lastObservedSinceMs = nowMs;
        pendingSinceMs = null;
        initialized = true;
        observationInterrupted = false;
        resetAuthorized = false;
        emptySinceMs = null;
        unavailableSinceMs = null;
    }

    internal CaptionEmission? Observe(string snapshot, long nowMs)
    {
        var current = NormalizeSnapshot(snapshot);
        if (!initialized)
        {
            Initialize(current, nowMs);
            return null;
        }
        if (current.Length == 0)
        {
            observationInterrupted = true;
            emptySinceMs ??= nowMs;
            if (nowMs - emptySinceMs.Value < stableForMs)
            {
                return null;
            }
            var interruptedEmission = pendingSinceMs is not null ? Commit(nowMs, allowReset: false) : null;
            resetAuthorized = true;
            return interruptedEmission;
        }

        if (observationInterrupted)
        {
            observationInterrupted = false;
            emptySinceMs = null;
            unavailableSinceMs = null;
            lastObserved = current;
            lastObservedSinceMs = nowMs;
            pendingSinceMs = string.Equals(baseline, current, StringComparison.Ordinal)
                ? null
                : pendingSinceMs ?? nowMs;
            if (pendingSinceMs is null)
            {
                resetAuthorized = false;
            }
            return null;
        }

        if (!string.Equals(lastObserved, current, StringComparison.Ordinal))
        {
            CaptionEmission? overdueEmission = null;
            if (pendingSinceMs is not null
                && nowMs - pendingSinceMs.Value >= maxPendingMs
                && CanFinalizePreviousObservation(lastObserved, current))
            {
                overdueEmission = Commit(nowMs);
            }
            lastObserved = current;
            lastObservedSinceMs = nowMs;
            pendingSinceMs ??= nowMs;
            return overdueEmission;
        }

        if (pendingSinceMs is null)
        {
            return null;
        }
        var stable = nowMs - lastObservedSinceMs >= stableForMs;
        if (!stable)
        {
            return null;
        }

        return Commit(nowMs);
    }

    internal CaptionEmission? Flush(long nowMs)
    {
        return initialized && pendingSinceMs is not null
            ? Commit(nowMs, allowReset: false)
            : null;
    }

    internal CaptionEmission? CurrentPreview(long nowMs)
    {
        if (!initialized
            || pendingSinceMs is null
            || observationInterrupted
            || lastObserved.Length == 0)
        {
            return null;
        }

        var caption = resetAuthorized
            ? BoundCaptionTail(lastObserved)
            : ExtractProvenDelta(baseline, lastObserved);
        if (caption.Length == 0 && ContainsNewCandidateTokens(baseline, lastObserved))
        {
            caption = BoundCaptionTail(lastObserved);
        }
        return caption.Length == 0
            ? null
            : new CaptionEmission(caption, pendingSinceMs.Value, Math.Max(pendingSinceMs.Value, nowMs));
    }

    internal CaptionEmission? Interrupt(long nowMs)
    {
        if (!initialized)
        {
            return null;
        }
        observationInterrupted = true;
        emptySinceMs = null;
        if (unavailableSinceMs is null)
        {
            unavailableSinceMs = nowMs;
            resetAuthorized = false;
        }
        lastObservedSinceMs = nowMs;
        if (nowMs - unavailableSinceMs.Value < stableForMs)
        {
            return null;
        }
        var interruptedEmission = pendingSinceMs is not null ? Commit(nowMs, allowReset: false) : null;
        resetAuthorized = true;
        return interruptedEmission;
    }

    internal static string ExtractProvenDelta(string previousSnapshot, string currentSnapshot)
    {
        var previous = NormalizeSnapshot(previousSnapshot);
        var current = NormalizeSnapshot(currentSnapshot);
        if (current.Length == 0 || string.Equals(previous, current, StringComparison.Ordinal))
        {
            return "";
        }
        if (previous.Length == 0)
        {
            return BoundCaptionTail(current);
        }
        if (current.StartsWith(previous, StringComparison.Ordinal)
            && IsTokenBoundary(previous, current))
        {
            return BoundCaptionTail(current[previous.Length..]);
        }
        if (previous.EndsWith(current, StringComparison.Ordinal))
        {
            return "";
        }

        var previousTokens = Tokenize(previous);
        var currentTokens = Tokenize(current);
        var maximumOverlap = Math.Min(previousTokens.Count, currentTokens.Count);
        for (var overlapLength = maximumOverlap; overlapLength >= 1; overlapLength -= 1)
        {
            var previousStart = previousTokens.Count - overlapLength;
            if (!IsReliableAnchor(previousTokens, previousStart, overlapLength)
                || !TokenRangeEquals(previousTokens, previousStart, currentTokens, 0, overlapLength))
            {
                continue;
            }
            return overlapLength < currentTokens.Count
                ? BoundCaptionTail(current[currentTokens[overlapLength].Start..])
                : "";
        }

        for (var overlapLength = maximumOverlap; overlapLength >= MinimumInteriorOverlapTokens; overlapLength -= 1)
        {
            var previousStart = previousTokens.Count - overlapLength;
            for (var currentStart = 0; currentStart + overlapLength <= currentTokens.Count; currentStart += 1)
            {
                if (!TokenRangeEquals(previousTokens, previousStart, currentTokens, currentStart, overlapLength))
                {
                    continue;
                }
                var candidateTokenIndex = currentStart + overlapLength;
                return candidateTokenIndex < currentTokens.Count
                    ? BoundCaptionTail(current[currentTokens[candidateTokenIndex].Start..])
                    : "";
            }
        }

        var commonPrefixLength = 0;
        while (commonPrefixLength < previousTokens.Count
            && commonPrefixLength < currentTokens.Count
            && string.Equals(previousTokens[commonPrefixLength].Key, currentTokens[commonPrefixLength].Key, StringComparison.Ordinal))
        {
            commonPrefixLength += 1;
        }
        if (commonPrefixLength > 0
            && IsReliableAnchor(previousTokens, 0, commonPrefixLength)
            && previousTokens.Count - commonPrefixLength <= MaximumRevisedTailTokens
            && commonPrefixLength < currentTokens.Count)
        {
            var revisedTail = BoundCaptionTail(current[currentTokens[commonPrefixLength].Start..]);
            return revisedTail.Length <= MaximumRevisedTailCharacters ? revisedTail : "";
        }

        return "";
    }

    internal static int RunDeterministicSelfTest()
    {
        var cases = 0;
        AssertEqual("Leo arrived.", ExtractProvenDelta(
            "The lessons began early the next morning.",
            "The lessons began early the next morning. Leo arrived."));
        cases += 1;

        AssertEqual("Leo struggled.", ExtractProvenDelta(
            "At first.",
            "At first, Leo struggled."));
        cases += 1;

        AssertEqual("his hands hurt.", ExtractProvenDelta(
            "At first, Leo struggled.",
            "At first, Leo struggled, his hands hurt."));
        cases += 1;

        AssertEqual("zeta eta", ExtractProvenDelta(
            "alpha beta gamma delta epsilon",
            "gamma delta epsilon zeta eta"));
        cases += 1;

        AssertEqual("", ExtractProvenDelta(
            "alpha beta",
            "completely unrelated rewrite"));
        cases += 1;

        AssertEqual("learn and then we will practice", ExtractProvenDelta(
            "alpha beta gamma we will",
            "we will learn and then we will practice"));
        cases += 1;

        AssertEqual("3:00 AM before sunrise", ExtractProvenDelta(
            "the bakery at three",
            "the bakery at 3:00 AM before sunrise"));
        cases += 1;

        AssertEqual("", ExtractProvenDelta(
            "bake",
            "bakery opened"));
        cases += 1;

        AssertEqual("", ExtractProvenDelta(
            "the bakery at three before the sun was up",
            "the bakery at 3:00 AM while everyone prepared the ovens"));
        cases += 1;

        AssertEqual("open today before sunrise", ExtractProvenDelta(
            "the bakery was closed yesterday",
            "the bakery was open today before sunrise"));
        cases += 1;

        AssertEqual("学习英语", ExtractProvenDelta(
            "我今天去学校",
            "我今天去学校学习英语"));
        cases += 1;

        var longStableSuffix = string.Join(" ", Enumerable.Range(0, 30).Select(index => $"stable{index}"));
        AssertEqual("before sunrise", ExtractProvenDelta(
            $"the bakery at three {longStableSuffix}",
            $"the bakery at 3:00 AM {longStableSuffix} before sunrise"));
        cases += 1;

        AssertEqual("", ExtractProvenDelta(
            "alpha beta",
            new string('x', MaximumCaptionCharacters + 1)));
        cases += 1;

        var longAppend = string.Join(" ", Enumerable.Range(0, 40).Select(index => $"append{index}"));
        var boundedAppend = ExtractProvenDelta("stable prefix", $"stable prefix {longAppend}");
        if (boundedAppend.Length == 0
            || boundedAppend.Length > MaximumCaptionCharacters
            || !boundedAppend.EndsWith("append39", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Caption stabilizer failed to bound a proven long append.");
        }
        cases += 1;

        var tracker = new CaptionSnapshotStabilizer(stableForMs: 750, maxPendingMs: 2000);
        tracker.Initialize("", 0);
        AssertEmission(null, tracker.Observe("Yes.", 250));
        AssertEmission("Yes.", tracker.Observe("Yes.", 1000), 250, 1000);
        AssertEmission(null, tracker.Observe("Yes.", 2000));
        cases += 1;

        const string longPrefix = "I'll make sure to help your bakery, too. The lessons began early the next morning. At first.";
        tracker.Initialize(longPrefix, 0);
        var revisedSnapshot = "I'll make sure to help your bakery, too. The lessons began early the next morning. At first, Leo struggled.";
        AssertEmission(null, tracker.Observe(revisedSnapshot, 250));
        var stabilized = tracker.Observe(revisedSnapshot, 1000);
        AssertEmission("Leo struggled.", stabilized, 250, 1000);
        if (stabilized?.Text.StartsWith("I'll make sure", StringComparison.Ordinal) == true)
        {
            throw new InvalidOperationException("Stabilizer emitted the cumulative Live Captions window.");
        }
        cases += 1;

        tracker.Initialize("", 0);
        AssertEmission(null, tracker.Observe("one", 100));
        AssertEmission(null, tracker.Observe("one two", 600));
        AssertEmission(null, tracker.Observe("one two three", 1200));
        AssertEmission("one two three", tracker.Observe("one two three four", 2100), 100, 2100);
        AssertEmission("four", tracker.Observe("one two three four", 2850), 2100, 2850);
        cases += 1;

        tracker.Initialize("", 0);
        AssertEmission(null, tracker.Observe("Mister And", 100));
        AssertEmission(null, tracker.Observe("Mister Anderson", 800));
        AssertEmission("Mister Anderson", tracker.Observe("Mister Anderson thought", 2100), 100, 2100);
        AssertEmission("thought", tracker.Observe("Mister Anderson thought", 2850), 2100, 2850);
        cases += 1;

        tracker.Initialize("", 0);
        var continuousSnapshot = "";
        var continuousEmissions = new List<CaptionEmission>();
        for (var index = 0; index < 40; index += 1)
        {
            continuousSnapshot = string.Join(" ", Enumerable.Range(0, index + 1).Select(word => $"word{word}"));
            var emission = tracker.Observe(continuousSnapshot, 100 + (index * 250));
            if (emission is not null)
            {
                continuousEmissions.Add(emission);
            }
        }
        var finalContinuousEmission = tracker.Observe(continuousSnapshot, 100 + (39 * 250) + 750);
        if (finalContinuousEmission is not null)
        {
            continuousEmissions.Add(finalContinuousEmission);
        }
        var reconstructedContinuousText = string.Join(" ", continuousEmissions.Select(emission => emission.Text));
        if (continuousEmissions.Count < 2
            || continuousEmissions.Any(emission => emission.Text.Length > MaximumCaptionCharacters)
            || !string.Equals(continuousSnapshot, reconstructedContinuousText, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Caption stabilizer failed to preserve bounded continuous speech batches.");
        }
        cases += 1;

        tracker.Initialize("alpha beta", 0);
        AssertEmission(null, tracker.Observe("completely different", 100));
        AssertEmission("completely different", tracker.Observe("completely different", 850), 100, 850);
        AssertEmission(null, tracker.Observe("completely different now", 1000));
        AssertEmission("now", tracker.Observe("completely different now", 1750), 1000, 1750);
        cases += 1;

        tracker.Initialize("the previous caption window remains here", 0);
        var replacement = string.Join(" ", Enumerable.Range(0, 40).Select(index => $"replacement{index}"));
        AssertEmission(null, tracker.Observe(replacement, 100));
        var replacementEmission = tracker.Observe(replacement, 850);
        if (replacementEmission is null
            || replacementEmission.Text.Length > MaximumCaptionCharacters
            || !replacementEmission.Text.EndsWith("replacement39", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Caption stabilizer failed to emit a bounded replacement window tail.");
        }
        cases += 1;

        tracker.Initialize("", 0);
        AssertEmission(null, tracker.Observe("interrupted tail", 100));
        AssertEmission(null, tracker.Observe("", 900));
        AssertEmission("interrupted tail", tracker.Observe("", 1650), 100, 1650);
        AssertEmission(null, tracker.Observe("interrupted tail", 1700));
        AssertEmission(null, tracker.Observe("interrupted tail", 2450));
        cases += 1;

        tracker.Initialize("old lesson", 0);
        AssertEmission(null, tracker.Observe("", 100));
        AssertEmission(null, tracker.Observe("", 850));
        AssertEmission(null, tracker.Observe("lesson starts now", 900));
        AssertEmission("lesson starts now", tracker.Observe("lesson starts now", 1650), 900, 1650);
        cases += 1;

        tracker.Initialize("", 0);
        AssertEmission(null, tracker.Observe("transient tail", 100));
        AssertEmission(null, tracker.Interrupt(200));
        AssertEmission(null, tracker.Observe("transient tail", 300));
        AssertEmission("transient tail", tracker.Observe("transient tail", 1050), 100, 1050);
        cases += 1;

        tracker.Initialize("base", 0);
        AssertEmission(null, tracker.Observe("base pending tail", 100));
        AssertEmission(null, tracker.Interrupt(200));
        AssertEmission("pending tail", tracker.Interrupt(950), 100, 950);
        AssertEmission(null, tracker.Observe("new window words", 1000));
        AssertEmission("new window words", tracker.Observe("new window words", 1750), 1000, 1750);
        cases += 1;

        tracker.Initialize("", 0);
        AssertEmission(null, tracker.Observe("final tail", 100));
        AssertEmission("final tail", tracker.Flush(250), 100, 250);
        cases += 1;

        return cases;
    }

    private static string NormalizeSnapshot(string value) => WhitespacePattern().Replace(value, " ").Trim();

    private static List<CaptionToken> Tokenize(string value)
    {
        return TokenPattern()
            .Matches(value)
            .Select(match => new CaptionToken(match.Value.ToUpperInvariant(), match.Index))
            .ToList();
    }

    private static bool IsReliableAnchor(IReadOnlyList<CaptionToken> tokens, int start, int length)
    {
        return length >= 2 || tokens[start].Key.Length >= 5;
    }

    private static bool TokenRangeEquals(
        IReadOnlyList<CaptionToken> left,
        int leftStart,
        IReadOnlyList<CaptionToken> right,
        int rightStart,
        int length)
    {
        for (var offset = 0; offset < length; offset += 1)
        {
            if (!string.Equals(left[leftStart + offset].Key, right[rightStart + offset].Key, StringComparison.Ordinal))
            {
                return false;
            }
        }
        return true;
    }

    private static void AssertEqual(string? expected, string? actual)
    {
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Caption stabilizer self-test failed. Expected '{expected ?? "<null>"}', got '{actual ?? "<null>"}'.");
        }
    }

    private static void AssertEmission(
        string? expectedText,
        CaptionEmission? actual,
        long? expectedStartMs = null,
        long? expectedEndMs = null)
    {
        if (expectedText is null)
        {
            if (actual is not null)
            {
                throw new InvalidOperationException($"Caption stabilizer self-test failed. Expected no emission, got '{actual.Text}'.");
            }
            return;
        }
        if (actual is null
            || !string.Equals(expectedText, actual.Text, StringComparison.Ordinal)
            || actual.StartMs != expectedStartMs
            || actual.EndMs != expectedEndMs)
        {
            throw new InvalidOperationException(
                $"Caption stabilizer self-test failed. Expected '{expectedText}' [{expectedStartMs}, {expectedEndMs}], "
                + $"got '{actual?.Text ?? "<null>"}' [{actual?.StartMs}, {actual?.EndMs}].");
        }
    }

    private CaptionEmission? Commit(long nowMs, bool allowReset = true)
    {
        var startMs = pendingSinceMs ?? nowMs;
        var caption = allowReset && resetAuthorized
            ? BoundCaptionTail(lastObserved)
            : ExtractProvenDelta(baseline, lastObserved);
        if (caption.Length == 0
            && allowReset
            && IsWindowReplacement(baseline, lastObserved))
        {
            caption = BoundCaptionTail(lastObserved);
        }
        baseline = lastObserved;
        pendingSinceMs = null;
        resetAuthorized = false;
        emptySinceMs = null;
        return caption.Length == 0
            ? null
            : new CaptionEmission(caption, startMs, Math.Max(startMs, nowMs));
    }

    private static string BoundCaption(string value)
    {
        var caption = value.Trim();
        return caption.Length <= MaximumCaptionCharacters && TokenPattern().IsMatch(caption) ? caption : "";
    }

    private static string BoundCaptionTail(string value)
    {
        var caption = value.Trim();
        if (caption.Length <= MaximumCaptionCharacters)
        {
            return BoundCaption(caption);
        }
        var tokens = Tokenize(caption);
        var first = tokens.FirstOrDefault(token => caption.Length - token.Start <= MaximumCaptionCharacters);
        return first is null ? "" : BoundCaption(caption[first.Start..]);
    }

    private static bool IsWindowReplacement(string previousSnapshot, string currentSnapshot)
    {
        var previous = NormalizeSnapshot(previousSnapshot);
        var current = NormalizeSnapshot(currentSnapshot);
        if (previous.Length == 0
            || current.Length == 0
            || previous.Contains(current, StringComparison.Ordinal)
            || current.Contains(previous, StringComparison.Ordinal))
        {
            return false;
        }
        var previousTokens = Tokenize(previous);
        var currentTokens = Tokenize(current);
        for (var previousIndex = 0; previousIndex + 1 < previousTokens.Count; previousIndex += 1)
        {
            for (var currentIndex = 0; currentIndex + 1 < currentTokens.Count; currentIndex += 1)
            {
                if (TokenRangeEquals(previousTokens, previousIndex, currentTokens, currentIndex, 2))
                {
                    return false;
                }
            }
        }
        return true;
    }

    private static bool ContainsNewCandidateTokens(string previousSnapshot, string currentSnapshot)
    {
        var previousTokens = Tokenize(NormalizeSnapshot(previousSnapshot));
        var currentTokens = Tokenize(NormalizeSnapshot(currentSnapshot));
        if (currentTokens.Count == 0)
        {
            return false;
        }
        for (var previousStart = 0; previousStart + currentTokens.Count <= previousTokens.Count; previousStart += 1)
        {
            if (TokenRangeEquals(previousTokens, previousStart, currentTokens, 0, currentTokens.Count))
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsTokenBoundary(string previous, string current)
    {
        return previous.Length == 0
            || current.Length == previous.Length
            || !IsTokenCharacter(previous[^1])
            || !IsTokenCharacter(current[previous.Length]);
    }

    private static bool CanFinalizePreviousObservation(string previousObservation, string currentObservation)
    {
        if (currentObservation.StartsWith(previousObservation, StringComparison.Ordinal)
            && IsTokenBoundary(previousObservation, currentObservation))
        {
            return true;
        }
        var previousTokens = Tokenize(previousObservation);
        var currentTokens = Tokenize(currentObservation);
        return previousTokens.Count > 0
            && previousTokens.Count < currentTokens.Count
            && TokenRangeEquals(previousTokens, 0, currentTokens, 0, previousTokens.Count);
    }

    private static bool IsTokenCharacter(char value)
    {
        return char.IsLetterOrDigit(value) || value is '\'' or '’';
    }

    private sealed record CaptionToken(string Key, int Start);

    [GeneratedRegex("[\\p{Lo}]|[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*")]
    private static partial Regex TokenPattern();

    [GeneratedRegex("\\s+")]
    private static partial Regex WhitespacePattern();
}
