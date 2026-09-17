namespace TingyiLite.SystemCaptionsHelper;

internal enum CaptionStreamLivenessTransition
{
    None,
    Reconnecting,
    Ready,
    Unavailable
}

internal sealed class CaptionStreamLivenessTracker
{
    private readonly long unavailableAfterMs;
    private long? disconnectedAtMs;

    internal CaptionStreamLivenessTracker(long unavailableAfterMs)
    {
        if (unavailableAfterMs <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(unavailableAfterMs));
        }
        this.unavailableAfterMs = unavailableAfterMs;
    }

    internal CaptionStreamLivenessTransition Observe(bool available, long nowMs)
    {
        if (available)
        {
            if (!disconnectedAtMs.HasValue)
            {
                return CaptionStreamLivenessTransition.None;
            }
            disconnectedAtMs = null;
            return CaptionStreamLivenessTransition.Ready;
        }

        if (!disconnectedAtMs.HasValue)
        {
            disconnectedAtMs = nowMs;
            return CaptionStreamLivenessTransition.Reconnecting;
        }
        return nowMs - disconnectedAtMs.Value >= unavailableAfterMs
            ? CaptionStreamLivenessTransition.Unavailable
            : CaptionStreamLivenessTransition.None;
    }

    internal static int RunDeterministicSelfTest()
    {
        var cases = 0;
        void Expect(CaptionStreamLivenessTransition expected, CaptionStreamLivenessTransition actual)
        {
            cases += 1;
            if (actual != expected)
            {
                throw new InvalidOperationException($"Liveness case {cases} expected {expected}, got {actual}.");
            }
        }

        var tracker = new CaptionStreamLivenessTracker(1000);
        Expect(CaptionStreamLivenessTransition.None, tracker.Observe(available: true, nowMs: 0));
        Expect(CaptionStreamLivenessTransition.Reconnecting, tracker.Observe(available: false, nowMs: 100));
        Expect(CaptionStreamLivenessTransition.None, tracker.Observe(available: false, nowMs: 1099));
        Expect(CaptionStreamLivenessTransition.Ready, tracker.Observe(available: true, nowMs: 1100));
        Expect(CaptionStreamLivenessTransition.None, tracker.Observe(available: true, nowMs: 1200));
        Expect(CaptionStreamLivenessTransition.Reconnecting, tracker.Observe(available: false, nowMs: 1300));
        Expect(CaptionStreamLivenessTransition.Unavailable, tracker.Observe(available: false, nowMs: 2300));
        Expect(CaptionStreamLivenessTransition.Ready, tracker.Observe(available: true, nowMs: 2400));
        return cases;
    }
}
