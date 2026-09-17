using System.Net.Http;
using System.IO;
using System.Net.Http.Headers;
using System.Text.Json;

namespace TingyiLite.Overlay;

public sealed class LiteCaptionClient
{
    private readonly HttpClient _httpClient;
    private readonly int _lines;
    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };
    private LiteState _state = new();
    private string? _serverInstanceId;
    private readonly CaptionPreviewTracker _previewTracker = new();

    public LiteCaptionClient(Uri server, int lines, string? token = null)
    {
        _lines = lines;
        _httpClient = new HttpClient { BaseAddress = server };
        if (!string.IsNullOrWhiteSpace(token))
        {
            _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }

    public event Action<OverlaySnapshot>? SnapshotChanged;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                ResetPreview();
                await LoadStateAsync(cancellationToken);
                await ReadEventStreamAsync(cancellationToken);
                ResetPreview();
                Publish(connected: false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                ResetPreview();
                Publish(connected: false);
            }
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(1.5), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task LoadStateAsync(CancellationToken cancellationToken)
    {
        ResetPreview();
        await using var stream = await _httpClient.GetStreamAsync("api/state", cancellationToken);
        var envelope = await JsonSerializer.DeserializeAsync<StateEnvelope>(stream, _jsonOptions, cancellationToken);
        _state = envelope?.State ?? new LiteState();
        _serverInstanceId = envelope?.ServerInstanceId;
        Publish(connected: true);
    }

    private async Task ReadEventStreamAsync(CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync("api/events", HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var dataLines = new List<string>();
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                return;
            }
            if (line.Length == 0)
            {
                if (dataLines.Count > 0)
                {
                    ApplyEvent(string.Join('\n', dataLines));
                    dataLines.Clear();
                }
                continue;
            }
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                dataLines.Add(line[5..].TrimStart());
            }
        }
    }

    internal void ApplyEvent(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty("eventType", out var eventTypeProperty))
        {
            if (document.RootElement.TryGetProperty("serverInstanceId", out var instanceProperty))
            {
                var instanceId = instanceProperty.GetString();
                if (!string.IsNullOrWhiteSpace(_serverInstanceId) && !string.Equals(_serverInstanceId, instanceId, StringComparison.Ordinal))
                {
                    ResetPreview();
                    throw new InvalidDataException("SSE server instance changed.");
                }
                _serverInstanceId = instanceId;
            }
            if (document.RootElement.TryGetProperty("lastCursor", out var helloCursor)
                && helloCursor.TryGetInt64(out var serverCursor)
                && serverCursor != _state.LastCursor)
            {
                throw new InvalidDataException($"SSE timeline mismatch: state={_state.LastCursor}, server={serverCursor}");
            }
            Publish(connected: true);
            return;
        }
        var eventType = eventTypeProperty.GetString();
        if (eventType == "caption.preview")
        {
            ApplyCaptionPreview(document.RootElement);
            return;
        }
        if (!document.RootElement.TryGetProperty("cursor", out var cursorProperty) || !cursorProperty.TryGetInt64(out var cursor))
        {
            throw new InvalidDataException("Lite event is missing a valid cursor.");
        }
        if (cursor <= _state.LastCursor)
        {
            return;
        }
        if (cursor != _state.LastCursor + 1)
        {
            throw new InvalidDataException($"SSE cursor gap: state={_state.LastCursor}, event={cursor}");
        }
        switch (eventType)
        {
            case "session.started":
                AddRecord<SessionRecord>(document.RootElement, "session", record => _state.Sessions[record.SessionId] = record);
                break;
            case "session.stop.requested":
                ApplySessionStopRequested(document.RootElement);
                break;
            case "session.ended":
                ApplySessionEnded(document.RootElement);
                break;
            case "source.attached":
                AddRecord<SourceRecord>(document.RootElement, "source", record => _state.Sources[record.SourceId] = record);
                break;
            case "source.status.changed":
                ApplySourceStatusChanged(document.RootElement);
                break;
            case "caption.received":
                AddRecord<CaptionSegment>(document.RootElement, "segment", record => _state.Captions[record.SegmentId] = record);
                break;
            case "translation.received":
                AddRecord<TranslationRecord>(document.RootElement, "translation", record => _state.Translations[record.SegmentId] = record);
                break;
        }
        _state.LastCursor = cursor;
        Publish(connected: true);
    }

    private void AddRecord<T>(JsonElement root, string property, Action<T> apply)
    {
        if (!root.TryGetProperty(property, out var value))
        {
            return;
        }
        var record = value.Deserialize<T>(_jsonOptions);
        if (record is not null)
        {
            apply(record);
        }
    }

    private void ApplySessionEnded(JsonElement root)
    {
        var sessionId = root.GetProperty("sessionId").GetString();
        if (sessionId is not null)
        {
            _previewTracker.ClearCurrent(item => item.SessionId == sessionId);
        }
        if (sessionId is null || !_state.Sessions.TryGetValue(sessionId, out var session))
        {
            return;
        }
        session.EndedAt = root.TryGetProperty("endedAt", out var endedAt) ? endedAt.GetString() : DateTimeOffset.UtcNow.ToString("O");
        foreach (var source in _state.Sources.Values.Where(item => item.SessionId == sessionId && item.Status != "failed"))
        {
            source.Status = "stopped";
        }
    }

    private void ApplySessionStopRequested(JsonElement root)
    {
        var sessionId = root.GetProperty("sessionId").GetString();
        if (sessionId is null || !_state.Sessions.TryGetValue(sessionId, out var session))
        {
            return;
        }
        session.StopRequestedAt = root.TryGetProperty("requestedAt", out var requestedAt)
            ? requestedAt.GetString()
            : DateTimeOffset.UtcNow.ToString("O");
    }

    private void ApplySourceStatusChanged(JsonElement root)
    {
        var sourceId = root.GetProperty("sourceId").GetString();
        var nextStatus = root.TryGetProperty("status", out var status) ? status.GetString() : null;
        if (sourceId is not null && nextStatus is "failed" or "stopped")
        {
            _previewTracker.ClearCurrent(item => item.SourceId == sourceId);
        }
        if (sourceId is null || !_state.Sources.TryGetValue(sourceId, out var source))
        {
            return;
        }
        source.Status = nextStatus ?? source.Status;
        source.LastError = root.TryGetProperty("lastError", out var lastError) ? lastError.GetString() : null;
    }

    private void ApplyCaptionPreview(JsonElement root)
    {
        var message = root.Deserialize<CaptionPreviewMessage>(_jsonOptions)
            ?? throw new InvalidDataException("Caption preview is invalid.");
        if (message.SchemaVersion != 1
            || message.EventType != "caption.preview"
            || string.IsNullOrWhiteSpace(message.SessionId)
            || string.IsNullOrWhiteSpace(message.SourceId)
            || string.IsNullOrWhiteSpace(message.StreamId)
            || message.Revision <= 0
            || (message.Action != "upsert" && message.Action != "clear")
            || !DateTimeOffset.TryParse(message.Timestamp, out _)
            || (message.Action == "upsert" && (
                string.IsNullOrWhiteSpace(message.Text)
                || message.StartMs is null or < 0
                || message.EndMs is null or < 0
                || message.EndMs < message.StartMs
                || message.Language is not ("en" or "zh" or "mixed"))))
        {
            throw new InvalidDataException("Caption preview has invalid fields.");
        }
        message.Text = message.Text?.Trim();
        if (_previewTracker.Apply(_serverInstanceId, message))
        {
            Publish(connected: true);
        }
    }

    private void ResetPreview() => _previewTracker.Reset();

    private void Publish(bool connected)
    {
        var session = SelectSession();
        if (session is null)
        {
            SnapshotChanged?.Invoke(new OverlaySnapshot("听译 Lite", "等待字幕", null, Array.Empty<OverlayCaptionLine>(), null, false, connected, false));
            return;
        }
        var captions = _state.Captions.Values
            .Where(caption => caption.SessionId == session.SessionId)
            .OrderByDescending(caption => caption.StartMs)
            .ThenByDescending(caption => caption.SegmentId, StringComparer.Ordinal)
            .Take(_lines)
            .ToArray();
        var context = captions
            .Select(caption => new OverlayCaptionLine(
                caption,
                _state.Translations.TryGetValue(caption.SegmentId, out var translation) ? translation.Text : null))
            .ToArray();
        var activeSource = _state.Sources.Values
            .Where(item => item.SessionId == session.SessionId && item.Kind != "browser-mic" && item.Status == "recording")
            .OrderBy(item => item.Priority)
            .FirstOrDefault();
        var startingSource = _state.Sources.Values
            .Where(item => item.SessionId == session.SessionId && item.Kind != "browser-mic" && item.Status == "starting")
            .OrderBy(item => item.Priority)
            .FirstOrDefault();
        var failed = _state.Sources.Values.Any(item =>
            item.SessionId == session.SessionId && item.Kind != "browser-mic" && item.Status == "failed");
        var preview = _previewTracker.Current;
        var visiblePreview = preview is not null
            && activeSource is not null
            && preview.SessionId == session.SessionId
            && preview.SourceId == activeSource.SourceId;
        SnapshotChanged?.Invoke(new OverlaySnapshot(
            session.Title,
            visiblePreview ? preview!.Text! : context.FirstOrDefault()?.Segment.Text ?? "等待字幕",
            visiblePreview ? null : context.FirstOrDefault()?.Translation,
            visiblePreview ? context.Take(Math.Max(0, _lines - 1)).ToArray() : context,
            !string.IsNullOrWhiteSpace(session.EndedAt) ? "会话已结束" : !string.IsNullOrWhiteSpace(session.StopRequestedAt) ? "正在收尾" : session.CaptureMode == "recording-only" ? "仅录音" : activeSource?.Label ?? (startingSource is not null ? $"正在启动 {startingSource.Label}" : failed ? "字幕已中断" : "等待字幕来源"),
            activeSource is not null && string.IsNullOrWhiteSpace(session.StopRequestedAt) && string.IsNullOrWhiteSpace(session.EndedAt),
            connected,
            visiblePreview));
    }

    private SessionRecord? SelectSession()
    {
        return _state.Sessions.Values
            .Where(session => string.IsNullOrWhiteSpace(session.EndedAt))
            .OrderByDescending(session => session.StartedAt, StringComparer.Ordinal)
            .FirstOrDefault()
            ?? _state.Sessions.Values
                .OrderByDescending(session => session.StartedAt, StringComparer.Ordinal)
                .FirstOrDefault();
    }
}
