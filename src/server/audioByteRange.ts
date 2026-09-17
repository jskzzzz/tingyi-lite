import type { ServerResponse } from "node:http";

export interface VerifiedAudioResponse {
  bytes: Buffer;
  mimeType: string;
  sha256: string;
  headers?: Record<string, string>;
}

export function sendVerifiedAudio(
  response: ServerResponse,
  audio: VerifiedAudioResponse,
  rangeHeader?: string
): void {
  const range = parseSingleByteRange(rangeHeader, audio.bytes.byteLength);
  const commonHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-tingyi-audio-sha256": audio.sha256,
    "x-tingyi-byte-length": String(audio.bytes.byteLength),
    ...audio.headers
  };
  if (rangeHeader !== undefined && !range) {
    response.writeHead(416, {
      ...commonHeaders,
      "content-range": `bytes */${audio.bytes.byteLength}`
    });
    response.end();
    return;
  }
  const body = range ? audio.bytes.subarray(range.start, range.end + 1) : audio.bytes;
  response.writeHead(range ? 206 : 200, {
    ...commonHeaders,
    "content-type": audio.mimeType,
    "content-length": String(body.byteLength),
    ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${audio.bytes.byteLength}` } : {})
  });
  response.end(body);
}

export function parseSingleByteRange(
  value: string | undefined,
  totalBytes: number
): { start: number; end: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return undefined;
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return {
      start: Math.max(0, totalBytes - suffixLength),
      end: totalBytes - 1
    };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= totalBytes || requestedEnd < start) {
    return undefined;
  }
  return {
    start,
    end: Math.min(requestedEnd, totalBytes - 1)
  };
}
