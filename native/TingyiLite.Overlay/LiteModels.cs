using System.Text.Json.Serialization;

namespace TingyiLite.Overlay;

public sealed class StateEnvelope
{
    public bool Ok { get; set; }
    public string ServerInstanceId { get; set; } = "";
    public LiteState State { get; set; } = new();
}

public sealed class LiteState
{
    public Dictionary<string, SessionRecord> Sessions { get; set; } = new();
    public Dictionary<string, SourceRecord> Sources { get; set; } = new();
    public Dictionary<string, CaptionSegment> Captions { get; set; } = new();
    public Dictionary<string, TranslationRecord> Translations { get; set; } = new();
    public long LastCursor { get; set; }
}

public sealed class SessionRecord
{
    public string SessionId { get; set; } = "";
    public string Title { get; set; } = "听译会话";
    public string StartedAt { get; set; } = "";
    public string? StopRequestedAt { get; set; }
    public string? EndedAt { get; set; }
    public string Language { get; set; } = "en";
    public string CaptureMode { get; set; } = "captions";
}

public sealed class SourceRecord
{
    public string SourceId { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Label { get; set; } = "";
    public string Status { get; set; } = "";
    public int Priority { get; set; }
    public string? LastError { get; set; }
}

public sealed class CaptionSegment
{
    public string SegmentId { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string SourceId { get; set; } = "";
    public string Text { get; set; } = "";
    public string Language { get; set; } = "en";
    public int StartMs { get; set; }
    public int EndMs { get; set; }
    public bool IsFinal { get; set; } = true;
}

public sealed class TranslationRecord
{
    public string SegmentId { get; set; } = "";
    public string Text { get; set; } = "";
}

public sealed class CaptionPreviewMessage
{
    public int SchemaVersion { get; set; }
    public string EventType { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string SourceId { get; set; } = "";
    public string StreamId { get; set; } = "";
    public long Revision { get; set; }
    public string Action { get; set; } = "";
    public string? Text { get; set; }
    public int? StartMs { get; set; }
    public int? EndMs { get; set; }
    public string? Language { get; set; }
    public string? Timestamp { get; set; }
}

public sealed class CaptionPreviewTracker
{
    private readonly Dictionary<string, long> _lastRevisionByStream = new(StringComparer.Ordinal);
    private string? _serverInstanceId;

    public CaptionPreviewMessage? Current { get; private set; }

    public bool Apply(string? serverInstanceId, CaptionPreviewMessage message)
    {
        if (string.IsNullOrWhiteSpace(serverInstanceId))
        {
            return false;
        }
        if (!string.Equals(_serverInstanceId, serverInstanceId, StringComparison.Ordinal))
        {
            Reset();
            _serverInstanceId = serverInstanceId;
        }
        if (_lastRevisionByStream.TryGetValue(message.StreamId, out var lastRevision)
            && message.Revision <= lastRevision)
        {
            return false;
        }
        _lastRevisionByStream[message.StreamId] = message.Revision;

        if (message.Action == "clear")
        {
            if (Current?.StreamId != message.StreamId)
            {
                return false;
            }
            Current = null;
            return true;
        }

        Current = message;
        return true;
    }

    public bool ClearCurrent(Func<CaptionPreviewMessage, bool>? predicate = null)
    {
        if (Current is null || (predicate is not null && !predicate(Current)))
        {
            return false;
        }
        Current = null;
        return true;
    }

    public void Reset()
    {
        Current = null;
        _lastRevisionByStream.Clear();
        _serverInstanceId = null;
    }
}

public sealed record OverlayCaptionLine(CaptionSegment Segment, string? Translation);

public sealed record OverlaySnapshot(
    string Title,
    string LatestCaption,
    string? LatestTranslation,
    IReadOnlyList<OverlayCaptionLine> Context,
    string? SourceLabel,
    bool Live,
    bool Connected,
    bool LatestIsPreview);

[JsonSerializable(typeof(StateEnvelope))]
[JsonSerializable(typeof(SessionRecord))]
[JsonSerializable(typeof(SourceRecord))]
[JsonSerializable(typeof(CaptionSegment))]
[JsonSerializable(typeof(TranslationRecord))]
[JsonSerializable(typeof(CaptionPreviewMessage))]
public sealed partial class LiteJsonContext : JsonSerializerContext;
