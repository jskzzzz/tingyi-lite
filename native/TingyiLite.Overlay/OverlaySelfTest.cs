using System.IO;

namespace TingyiLite.Overlay;

internal static class OverlaySelfTest
{
    public static void Run()
    {
        VerifyPreviewOrdering();
        VerifyPreviewClearing();
        VerifyCursorlessPreviewProtocol();
    }

    private static void VerifyPreviewOrdering()
    {
        var tracker = new CaptionPreviewTracker();
        Assert(tracker.Apply("server-a", Preview("stream-a", 1, "first")), "first preview must be accepted");
        Assert(!tracker.Apply("server-a", Preview("stream-a", 1, "duplicate")), "duplicate revision must be ignored");
        Assert(!tracker.Apply("server-a", Preview("stream-a", 0, "old")), "older revision must be ignored");
        Assert(tracker.Current?.Text == "first", "ignored revisions must not replace the current preview");

        Assert(tracker.Apply("server-b", Preview("stream-a", 1, "new server")), "a new server instance must reset revision ordering");
        Assert(tracker.Current?.Text == "new server", "the new server preview must become current");
    }

    private static void VerifyPreviewClearing()
    {
        var tracker = new CaptionPreviewTracker();
        Assert(tracker.Apply("server-a", Preview("stream-a", 1, "active")), "preview setup failed");
        Assert(!tracker.Apply("server-a", Clear("stream-b", 1)), "another stream must not clear the current preview");
        Assert(tracker.Current?.Text == "active", "another stream clear changed the current preview");
        Assert(tracker.Apply("server-a", Clear("stream-a", 2)), "current stream clear must be accepted");
        Assert(tracker.Current is null, "current stream clear did not remove the preview");
        Assert(!tracker.Apply("server-a", Preview("stream-a", 1, "late")), "a late upsert after clear must be ignored");
    }

    private static void VerifyCursorlessPreviewProtocol()
    {
        var client = new LiteCaptionClient(new Uri("http://127.0.0.1/"), 2);
        OverlaySnapshot? snapshot = null;
        client.SnapshotChanged += next => snapshot = next;
        client.ApplyEvent("""{"serverInstanceId":"server-a","lastCursor":0}""");
        client.ApplyEvent("""{"eventType":"session.started","cursor":1,"session":{"sessionId":"session-a","title":"Test","startedAt":"2026-07-19T00:00:00Z","language":"en","captureMode":"captions"}}""");
        client.ApplyEvent("""{"eventType":"source.attached","cursor":2,"source":{"sourceId":"source-a","sessionId":"session-a","kind":"system-captions","label":"System captions","status":"starting","priority":1}}""");
        client.ApplyEvent("""{"eventType":"source.status.changed","cursor":3,"sourceId":"source-a","status":"recording"}""");
        client.ApplyEvent("""{"eventType":"caption.received","cursor":4,"segment":{"segmentId":"segment-a","sessionId":"session-a","sourceId":"source-a","text":"durable","language":"en","startMs":0,"endMs":100,"isFinal":true}}""");
        client.ApplyEvent("""{"eventType":"translation.received","cursor":5,"translation":{"segmentId":"segment-a","text":"持久字幕"}}""");
        client.ApplyEvent("""{"schemaVersion":1,"eventType":"caption.preview","sessionId":"session-a","sourceId":"source-a","streamId":"stream-a","revision":1,"action":"upsert","text":"live","startMs":0,"endMs":100,"language":"en","timestamp":"2026-07-19T00:00:00Z"}""");
        var previewSnapshot = snapshot ?? throw new InvalidOperationException("Overlay self-test failed: preview snapshot was not published");
        Assert(previewSnapshot is { LatestCaption: "live", LatestTranslation: null, LatestIsPreview: true }, "active preview must replace the latest durable caption and hide translation");
        Assert(previewSnapshot.Context.Count == 1 && previewSnapshot.Context[0].Segment.Text == "durable" && previewSnapshot.Context[0].Translation == "持久字幕", "preview must not alter durable context");

        client.ApplyEvent("""{"schemaVersion":1,"eventType":"caption.preview","sessionId":"session-a","sourceId":"source-a","streamId":"stream-a","revision":2,"action":"clear","timestamp":"2026-07-19T00:00:01Z"}""");
        Assert(snapshot is { LatestCaption: "durable", LatestTranslation: "持久字幕", LatestIsPreview: false }, "clear must restore the durable caption and translation");

        client.ApplyEvent("""{"schemaVersion":1,"eventType":"caption.preview","sessionId":"session-a","sourceId":"source-a","streamId":"stream-a","revision":3,"action":"upsert","text":"interrupted","startMs":100,"endMs":200,"language":"en","timestamp":"2026-07-19T00:00:02Z"}""");
        client.ApplyEvent("""{"eventType":"source.status.changed","cursor":6,"sourceId":"source-a","status":"failed"}""");
        Assert(snapshot is { LatestCaption: "durable", LatestIsPreview: false }, "a failed source must clear its preview");

        client.ApplyEvent("""{"eventType":"source.status.changed","cursor":7,"sourceId":"source-a","status":"recording"}""");
        client.ApplyEvent("""{"schemaVersion":1,"eventType":"caption.preview","sessionId":"session-a","sourceId":"source-a","streamId":"stream-a","revision":4,"action":"upsert","text":"ending","startMs":200,"endMs":300,"language":"en","timestamp":"2026-07-19T00:00:03Z"}""");
        client.ApplyEvent("""{"eventType":"session.ended","cursor":8,"sessionId":"session-a","endedAt":"2026-07-19T00:00:04Z"}""");
        Assert(snapshot is { LatestCaption: "durable", LatestIsPreview: false }, "an ended session must clear its preview");

        var threw = false;
        try
        {
            client.ApplyEvent("""{"eventType":"caption.received"}""");
        }
        catch (InvalidDataException)
        {
            threw = true;
        }
        Assert(threw, "durable events must still require a cursor");
    }

    private static CaptionPreviewMessage Preview(string streamId, long revision, string text) => new()
    {
        SchemaVersion = 1,
        EventType = "caption.preview",
        SessionId = "session-a",
        SourceId = "source-a",
        StreamId = streamId,
        Revision = revision,
        Action = "upsert",
        Text = text,
        StartMs = 0,
        EndMs = 100,
        Language = "en",
        Timestamp = "2026-07-19T00:00:00Z"
    };

    private static CaptionPreviewMessage Clear(string streamId, long revision) => new()
    {
        SchemaVersion = 1,
        EventType = "caption.preview",
        SessionId = "session-a",
        SourceId = "source-a",
        StreamId = streamId,
        Revision = revision,
        Action = "clear",
        Timestamp = "2026-07-19T00:00:00Z"
    };

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Overlay self-test failed: {message}");
        }
    }
}
