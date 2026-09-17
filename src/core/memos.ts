import type { CaptionLanguage, MemosVisibility } from "./schema";

const PCM16_MONO_HEADER_BYTES = 44;

/**
 * memo 末尾的固定标签：产品级的英语听译标识，不随会话标题变化。
 * Memos 把无空格的 `#标签` 渲染为可点击标签，带空格会被当成 Markdown 标题，所以此处不能有空格。
 */
export const MEMOS_MEMO_TAG = "#英语听译";

export interface Pcm16MonoWav {
  sampleRateHz: number;
  data: Buffer;
}

export interface MemosCaptionLine {
  segmentId: string;
  startMs: number;
  text: string;
}

export interface MemosMemoContentInput {
  title: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  language: CaptionLanguage;
  deviceId: string;
  sourceLabel?: string;
  localAsrEngineId?: string;
  captions: MemosCaptionLine[];
  translations?: Array<{ segmentId: string; text: string }>;
  audioDurationMs?: number;
  audioFilenames: string[];
}

/**
 * Memos 拒绝明文 HTTP 上的凭据，除非目标是 loopback 或 Tailscale CGNAT 网段：
 * Tailscale 链路本身由 WireGuard 加密并对端已认证，明文 HTTP 不会在网络上暴露 token。
 * 其它非 loopback 明文地址必须由运维显式打开开关，不做静默降级。
 */
export function memosBaseUrlError(baseUrl: string, options: { allowInsecureHttp: boolean }): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "Memos base URL must be an absolute URL";
  }
  if (url.protocol === "https:") {
    return undefined;
  }
  if (url.protocol !== "http:") {
    return "Memos base URL must use http or https";
  }
  if (isLoopbackHostname(url.hostname) || isTailscaleAddress(url.hostname) || options.allowInsecureHttp) {
    return undefined;
  }
  return "Memos base URL must use HTTPS unless the host is loopback, a Tailscale address, or TINGYI_MEMOS_ALLOW_INSECURE_HTTP=1 is set";
}

export function memosEndpointUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function memosMemoUrl(baseUrl: string, memoId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/memos/${encodeURIComponent(memoId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Tailscale 把节点地址分配在 100.64.0.0/10（CGNAT 段）。 */
export function isTailscaleAddress(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function memosUploadLimitBytes(uploadSizeLimitMb: string | number): number {
  const megabytes = Number(uploadSizeLimitMb);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`Memos upload size limit is invalid: ${uploadSizeLimitMb}`);
  }
  return Math.floor(megabytes * 1024 * 1024);
}

export function parsePcm16MonoWav(wav: Buffer): Pcm16MonoWav {
  if (
    wav.byteLength < PCM16_MONO_HEADER_BYTES
    || wav.toString("ascii", 0, 4) !== "RIFF"
    || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.toString("ascii", 12, 16) !== "fmt "
    || wav.readUInt32LE(16) !== 16
    || wav.readUInt16LE(20) !== 1
    || wav.readUInt16LE(22) !== 1
    || wav.readUInt16LE(34) !== 16
    || wav.toString("ascii", 36, 40) !== "data"
    || wav.readUInt32LE(40) !== wav.byteLength - PCM16_MONO_HEADER_BYTES
  ) {
    throw new Error("Recording chunk must be a mono PCM16 WAV");
  }
  const sampleRateHz = wav.readUInt32LE(24);
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error("Recording chunk has an invalid sample rate");
  }
  return { sampleRateHz, data: wav.subarray(PCM16_MONO_HEADER_BYTES) };
}

/**
 * 按时间线合并同一来源的录音分块，结果始终从时间轴的 0 开始：
 * 第一块之前的开头段和分块之间的空档都用静音补齐，
 * 这样合并后的音频位置与字幕的会话内偏移一一对应；
 * 不补开头就会让所有时间戳比音频提前（实测真实会话里差了 9 秒）。
 * 格式不一致直接失败。
 */
export function mergePcm16MonoWavs(chunks: Array<{ startMs: number; endMs: number; wav: Buffer }>): Buffer {
  if (chunks.length === 0) {
    throw new Error("Cannot merge an empty audio chunk list");
  }
  const parsed = chunks.map((chunk) => ({ ...chunk, ...parsePcm16MonoWav(chunk.wav) }));
  const sampleRateHz = parsed[0].sampleRateHz;
  for (const chunk of parsed) {
    if (chunk.sampleRateHz !== sampleRateHz) {
      throw new Error(`Recording chunks must share one sample rate; found ${sampleRateHz} and ${chunk.sampleRateHz}`);
    }
  }
  const parts: Buffer[] = [];
  let total = 0;
  let previousEndMs = 0;
  for (const chunk of parsed) {
    if (chunk.startMs < previousEndMs) {
      throw new Error("Recording chunks must be time ordered and non-overlapping");
    }
    const missingSamples = Math.round(((chunk.startMs - previousEndMs) * sampleRateHz) / 1_000);
    if (missingSamples > 0) {
      const silence = Buffer.alloc(missingSamples * 2);
      parts.push(silence);
      total += silence.byteLength;
    }
    parts.push(chunk.data);
    total += chunk.data.byteLength;
    previousEndMs = chunk.endMs;
  }
  return createPcm16MonoWav(Buffer.concat(parts, total), sampleRateHz);
}

/** 按字节上限分卷，每卷都是完整可播放的 WAV；切点按采样帧对齐。 */
export function splitPcm16MonoWav(wav: Buffer, maxBytes: number): Buffer[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= PCM16_MONO_HEADER_BYTES) {
    throw new Error(`Memos upload limit is too small for a WAV header: ${maxBytes}`);
  }
  const { sampleRateHz, data } = parsePcm16MonoWav(wav);
  const frameBytes = 2;
  const usableBytes = Math.floor((maxBytes - PCM16_MONO_HEADER_BYTES) / frameBytes) * frameBytes;
  if (usableBytes <= 0) {
    throw new Error(`Memos upload limit is too small for one sample frame: ${maxBytes}`);
  }
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += usableBytes) {
    const slice = data.subarray(offset, Math.min(offset + usableBytes, data.byteLength));
    parts.push(createPcm16MonoWav(Buffer.from(slice), sampleRateHz));
  }
  return parts.length > 0 ? parts : [createPcm16MonoWav(Buffer.alloc(0), sampleRateHz)];
}

export function pcm16MonoWavDurationMs(wav: Buffer): number {
  const { sampleRateHz, data } = parsePcm16MonoWav(wav);
  return Math.round((data.byteLength / 2 / sampleRateHz) * 1_000);
}

export function formatMemosTimestamp(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1_000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * memo 标题里的日期时间，按运行本机的时区渲染，与界面里显示的时间一致；
 * 存储的 ISO 时间是 UTC，直接用会与本地日期差一天。
 */
export function formatMemosLocalDateTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Memos memo title requires a valid start time: ${isoTimestamp}`);
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatMemosDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainingMinutes} 分`;
}

export function buildMemosMemoContent(input: MemosMemoContentInput): string {
  const translations = new Map((input.translations ?? []).map((entry) => [entry.segmentId, entry.text]));
  const lines: string[] = [`# ${input.title} ${formatMemosLocalDateTime(input.startedAt)}`, "", "| 项 | 值 |", "| --- | --- |"];
  lines.push(`| 会话 | \`${input.sessionId}\` |`);
  lines.push(`| 开始时间 | ${input.startedAt} |`);
  if (input.endedAt) {
    lines.push(`| 结束时间 | ${input.endedAt} |`);
  }
  const durationMs = input.audioDurationMs ?? lastCaptionEndMs(input.captions);
  if (durationMs !== undefined && durationMs > 0) {
    lines.push(`| 时长 | ${formatMemosDuration(durationMs)} |`);
  }
  lines.push(`| 语言 | ${input.language} |`);
  if (input.sourceLabel) {
    lines.push(`| 字幕来源 | ${input.sourceLabel} |`);
  }
  if (input.localAsrEngineId) {
    lines.push(`| 识别引擎 | \`${input.localAsrEngineId}\` |`);
  }
  lines.push(`| 设备 | \`${input.deviceId}\` |`);
  if (input.audioFilenames.length > 0) {
    lines.push(`| 录音 | ${input.audioFilenames.map((name) => `\`${name}\``).join("、")} |`);
  }
  lines.push("", "## 字幕", "");
  if (input.captions.length === 0) {
    lines.push("_本次会话没有落盘字幕。_");
  } else {
    for (const caption of input.captions) {
      const text = caption.text.replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }
      const translated = translations.get(caption.segmentId)?.replace(/\s+/g, " ").trim();
      const stamp = formatMemosTimestamp(caption.startMs);
      lines.push(`**${stamp}** ${text}`);
      if (translated) {
        lines.push(`> ${translated}`);
      }
      lines.push("");
    }
  }
  lines.push("", MEMOS_MEMO_TAG);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function memosVisibilityLabel(visibility: MemosVisibility): string {
  switch (visibility) {
    case "PRIVATE":
      return "私有";
    case "PROTECTED":
      return "登录可见";
    case "PUBLIC":
      return "公开";
  }
}

function lastCaptionEndMs(captions: MemosCaptionLine[]): number | undefined {
  return captions.length > 0 ? Math.max(...captions.map((caption) => caption.startMs)) : undefined;
}

function createPcm16MonoWav(pcm: Buffer, sampleRateHz: number): Buffer {
  const wav = Buffer.allocUnsafe(PCM16_MONO_HEADER_BYTES + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
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
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, PCM16_MONO_HEADER_BYTES);
  return wav;
}
