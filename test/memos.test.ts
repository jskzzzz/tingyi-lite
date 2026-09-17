import { describe, expect, it } from "vitest";
import {
  buildMemosMemoContent,
  formatMemosDuration,
  formatMemosLocalDateTime,
  formatMemosTimestamp,
  isTailscaleAddress,
  MEMOS_MEMO_TAG,
  memosBaseUrlError,
  memosEndpointUrl,
  memosMemoUrl,
  memosUploadLimitBytes,
  mergePcm16MonoWavs,
  parsePcm16MonoWav,
  pcm16MonoWavDurationMs,
  splitPcm16MonoWav
} from "../src/core/memos";

describe("Memos base URL policy", () => {
  it("accepts HTTPS anywhere and plain HTTP only on loopback or Tailscale", () => {
    expect(memosBaseUrlError("https://memos.example.com", { allowInsecureHttp: false })).toBeUndefined();
    expect(memosBaseUrlError("http://127.0.0.1:5230", { allowInsecureHttp: false })).toBeUndefined();
    expect(memosBaseUrlError("http://localhost:5230", { allowInsecureHttp: false })).toBeUndefined();
    expect(memosBaseUrlError("http://100.64.12.34:5230", { allowInsecureHttp: false })).toBeUndefined();
    expect(memosBaseUrlError("http://[::1]:5230", { allowInsecureHttp: false })).toBeUndefined();
  });

  it("rejects plain HTTP outside the trusted ranges unless explicitly allowed", () => {
    expect(memosBaseUrlError("http://203.0.113.10:5230", { allowInsecureHttp: false }))
      .toContain("TINGYI_MEMOS_ALLOW_INSECURE_HTTP");
    expect(memosBaseUrlError("http://203.0.113.10:5230", { allowInsecureHttp: true })).toBeUndefined();
    expect(memosBaseUrlError("ftp://memos.example.com", { allowInsecureHttp: true })).toContain("must use http or https");
    expect(memosBaseUrlError("not-a-url", { allowInsecureHttp: true })).toContain("absolute URL");
  });

  it("treats only the CGNAT 100.64.0.0/10 range as Tailscale", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    expect(isTailscaleAddress("100.63.255.255")).toBe(false);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("10.0.0.1")).toBe(false);
    expect(isTailscaleAddress("100.64.0")).toBe(false);
    expect(isTailscaleAddress("100.64.0.256")).toBe(false);
  });

  it("builds memo links from the configured base URL", () => {
    expect(memosMemoUrl("http://100.64.12.34:5230", "abc123")).toBe("http://100.64.12.34:5230/memos/abc123");
    expect(memosMemoUrl("https://memos.example.com/", "a/b")).toBe("https://memos.example.com/memos/a%2Fb");
  });

  it("keeps a reverse-proxy sub-path when building API URLs", () => {
    expect(memosEndpointUrl("https://example.com/memos", "/api/v1/memos")).toBe("https://example.com/memos/api/v1/memos");
    expect(memosEndpointUrl("https://example.com/memos/", "/api/v1/attachments")).toBe("https://example.com/memos/api/v1/attachments");
    expect(memosEndpointUrl("https://example.com", "/api/v1/memos")).toBe("https://example.com/api/v1/memos");
    // A sub-path is still an ordinary HTTPS origin, so the credential policy allows it.
    expect(memosBaseUrlError("https://example.com/memos", { allowInsecureHttp: false })).toBeUndefined();
  });

  it("converts the instance upload limit to bytes and rejects invalid limits", () => {
    expect(memosUploadLimitBytes("30")).toBe(31_457_280);
    expect(memosUploadLimitBytes(30)).toBe(31_457_280);
    expect(() => memosUploadLimitBytes("abc")).toThrow("upload size limit is invalid");
    expect(() => memosUploadLimitBytes(0)).toThrow("upload size limit is invalid");
  });
});

describe("Memos WAV assembly", () => {
  it("merges chunks on one timeline and fills gaps with silence", () => {
    const merged = mergePcm16MonoWavs([
      { startMs: 0, endMs: 250, wav: monoWav(16_000, 250) },
      { startMs: 500, endMs: 750, wav: monoWav(16_000, 250) }
    ]);
    const parsed = parsePcm16MonoWav(merged);
    expect(parsed.sampleRateHz).toBe(16_000);
    // 250 ms of audio + 250 ms of synthesized silence + 250 ms of audio.
    expect(pcm16MonoWavDurationMs(merged)).toBe(750);
    expect(merged.byteLength).toBe(44 + 750 * 32);
    const silence = merged.subarray(44 + 8_000, 44 + 16_000);
    expect(silence.every((byte) => byte === 0)).toBe(true);
  });

  it("pads leading silence so audio positions match the session timeline", () => {
    // Real sessions start capturing several seconds after session.started; without the
    // leading pad every caption timestamp would sit earlier than its audio.
    const merged = mergePcm16MonoWavs([
      { startMs: 9_000, endMs: 9_250, wav: monoWav(16_000, 250) }
    ]);
    expect(pcm16MonoWavDurationMs(merged)).toBe(9_250);
    const leading = merged.subarray(44, 44 + 9_000 * 32);
    expect(leading.every((byte) => byte === 0)).toBe(true);
    // The captured audio must remain at its absolute position, not slide forward.
    expect(merged.subarray(44 + 9_000 * 32).equals(monoWav(16_000, 250).subarray(44))).toBe(true);
  });

  it("rejects empty, mismatched, overlapping and unordered chunk lists", () => {
    expect(() => mergePcm16MonoWavs([])).toThrow("empty audio chunk list");
    expect(() => mergePcm16MonoWavs([
      { startMs: 0, endMs: 250, wav: monoWav(16_000, 250) },
      { startMs: 250, endMs: 500, wav: monoWav(24_000, 250) }
    ])).toThrow("must share one sample rate");
    expect(() => mergePcm16MonoWavs([
      { startMs: 0, endMs: 500, wav: monoWav(16_000, 500) },
      { startMs: 250, endMs: 750, wav: monoWav(16_000, 500) }
    ])).toThrow("time ordered and non-overlapping");
  });

  it("splits oversized audio into frame-aligned playable parts", () => {
    const source = mergePcm16MonoWavs([{ startMs: 0, endMs: 1_000, wav: monoWav(16_000, 1_000) }]);
    const limit = 44 + 4_000;
    const parts = splitPcm16MonoWav(source, limit);
    expect(parts.length).toBeGreaterThan(1);

    let totalData = 0;
    let totalDuration = 0;
    for (const part of parts) {
      expect(part.byteLength).toBeLessThanOrEqual(limit);
      const parsed = parsePcm16MonoWav(part);
      expect(parsed.data.byteLength % 2).toBe(0);
      totalData += parsed.data.byteLength;
      totalDuration += pcm16MonoWavDurationMs(part);
    }
    expect(totalData).toBe(parsePcm16MonoWav(source).data.byteLength);
    expect(totalDuration).toBe(1_000);
  });

  it("refuses a limit that cannot hold one sample frame", () => {
    const source = mergePcm16MonoWavs([{ startMs: 0, endMs: 100, wav: monoWav(16_000, 100) }]);
    expect(() => splitPcm16MonoWav(source, 45)).toThrow("too small for one sample frame");
    expect(() => splitPcm16MonoWav(source, 10)).toThrow("too small for a WAV header");
  });
});

describe("Memos memo content", () => {
  it("formats timestamps and durations", () => {
    expect(formatMemosTimestamp(0)).toBe("00:00");
    expect(formatMemosTimestamp(34_329)).toBe("00:34");
    expect(formatMemosTimestamp(95_789)).toBe("01:35");
    expect(formatMemosTimestamp(3_725_000)).toBe("1:02:05");
    expect(formatMemosDuration(45_000)).toBe("45 秒");
    expect(formatMemosDuration(120_000)).toBe("2 分钟");
    expect(formatMemosDuration(113_000)).toBe("1 分 53 秒");
    expect(formatMemosDuration(3_900_000)).toBe("1 小时 5 分");
  });

  it("formats the memo title date in local time", () => {
    // The stored instant is UTC, so the rendered title must follow the host timezone while
    // keeping a stable, sortable format.
    const startedAt = "2026-08-28T08:32:19.670Z";
    const local = new Date(startedAt);
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(formatMemosLocalDateTime(startedAt)).toBe(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`
    );
    expect(formatMemosLocalDateTime(startedAt)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(() => formatMemosLocalDateTime("not-a-time")).toThrow("requires a valid start time");
  });

  it("renders metadata, timestamped captions, translations and audio filenames", () => {
    const content = buildMemosMemoContent({
      title: "示例会议记录",
      sessionId: "session_20260102030405_00000000000000000000000000000000",
      startedAt: "2026-01-02T03:04:05.000Z",
      endedAt: "2026-01-02T03:05:05.000Z",
      language: "zh",
      deviceId: "device_00000000000040008000000000000000",
      sourceLabel: "FunASR Paraformer 2-pass 中文（本地识别）",
      localAsrEngineId: "funasr-paraformer-zh-2pass",
      captions: [
        { segmentId: "segment_a", startMs: 34_329, text: "我们先把会议时间改到明天下午" },
        { segmentId: "segment_b", startMs: 60_899, text: "记得提醒产品经理准备季度数据" }
      ],
      translations: [{ segmentId: "segment_b", text: "The meeting is moved to tomorrow afternoon." }],
      audioDurationMs: 113_000,
      audioFilenames: ["tingyi-20260102030405-audio-16000hz.wav"]
    });

    expect(content.startsWith("# 示例会议记录 ")).toBe(true);
    expect(content.split("\n")[0]).toMatch(/^# 示例会议记录 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(content).toContain("| 时长 | 1 分 53 秒 |");
    expect(content).toContain("| 识别引擎 | `funasr-paraformer-zh-2pass` |");
    expect(content).toContain("| 录音 | `tingyi-20260102030405-audio-16000hz.wav` |");
    expect(content).toContain("**00:34** 我们先把会议时间改到明天下午");
    expect(content).toContain("> The meeting is moved to tomorrow afternoon.");
    // Captions without a translation must not gain an empty quote line.
    expect(content).toContain("**00:34** 我们先把会议时间改到明天下午\n\n**01:00**");
    expect(content.endsWith(`${MEMOS_MEMO_TAG}\n`)).toBe(true);
    expect(content).toContain(`\n\n${MEMOS_MEMO_TAG}\n`);
    expect(content.split("\n").filter((line) => line === MEMOS_MEMO_TAG)).toHaveLength(1);
  });

  it("falls back to the last caption offset when audio duration is unknown", () => {
    const content = buildMemosMemoContent({
      title: "无声会话",
      sessionId: "session_x",
      startedAt: "2026-01-02T03:04:05.000Z",
      language: "zh",
      deviceId: "device_x",
      captions: [{ segmentId: "segment_a", startMs: 120_000, text: "只有字幕" }],
      audioFilenames: []
    });
    expect(content).toContain("| 时长 | 2 分钟 |");
    expect(content).toContain("**02:00** 只有字幕");
    expect(content.endsWith(`${MEMOS_MEMO_TAG}\n`)).toBe(true);
  });

  it("marks sessions without captions explicitly", () => {
    const content = buildMemosMemoContent({
      title: "纯录音",
      sessionId: "session_y",
      startedAt: "2026-01-02T03:04:05.000Z",
      language: "en",
      deviceId: "device_y",
      captions: [],
      audioFilenames: ["a.wav"]
    });
    expect(content).toContain("_本次会话没有落盘字幕。_");
    expect(content.endsWith(`\n\n${MEMOS_MEMO_TAG}\n`)).toBe(true);
  });
});

function monoWav(sampleRateHz: number, durationMs: number): Buffer {
  const samples = Math.round((sampleRateHz * durationMs) / 1_000);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; ++index) {
    data.writeInt16LE(((index % 100) - 50) * 100, index * 2);
  }
  const wav = Buffer.alloc(44 + data.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data.byteLength, 40);
  data.copy(wav, 44);
  return wav;
}
