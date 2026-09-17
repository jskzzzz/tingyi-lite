export interface PcmWavRecordingSegment {
  startMs: number;
  endMs: number;
  audio: Buffer;
}

export interface PcmWavRecordingChunk {
  index: number;
  startMs: number;
  endMs: number;
  audio: Buffer;
}

export interface PcmWavRecorderOptions {
  sampleRateHz: number;
  chunkDurationMs?: number;
}

const DEFAULT_RECORDING_CHUNK_MS = 30_000;

export class PcmWavRecorder {
  private readonly chunkDurationMs: number;
  private readonly pcmParts: Buffer[] = [];
  private bufferedBytes = 0;
  private chunkStartMs: number | undefined;
  private chunkEndMs: number | undefined;
  private lastSegmentEndMs: number | undefined;
  private nextChunkIndex = 1;

  constructor(private readonly options: PcmWavRecorderOptions) {
    positiveInteger(options.sampleRateHz, "sampleRateHz");
    this.chunkDurationMs = positiveInteger(options.chunkDurationMs ?? DEFAULT_RECORDING_CHUNK_MS, "chunkDurationMs");
  }

  append(segment: PcmWavRecordingSegment): PcmWavRecordingChunk[] {
    validateTimeline(segment, this.lastSegmentEndMs);
    const pcm = parsePcm16MonoWav(segment.audio, this.options.sampleRateHz);
    const segmentDurationMs = Math.round((pcm.byteLength / 2) * 1_000 / this.options.sampleRateHz);
    if (segmentDurationMs !== segment.endMs - segment.startMs) {
      throw new Error("Recording segment audio duration does not match its timeline");
    }
    this.chunkStartMs ??= segment.startMs;
    if (this.lastSegmentEndMs !== undefined && segment.startMs > this.lastSegmentEndMs) {
      const missingSamples = Math.round((segment.startMs - this.lastSegmentEndMs) * this.options.sampleRateHz / 1_000);
      const silence = Buffer.alloc(missingSamples * 2);
      this.pcmParts.push(silence);
      this.bufferedBytes += silence.byteLength;
    }
    this.chunkEndMs = segment.endMs;
    this.lastSegmentEndMs = segment.endMs;
    this.pcmParts.push(pcm);
    this.bufferedBytes += pcm.byteLength;
    if (this.chunkEndMs - this.chunkStartMs < this.chunkDurationMs) {
      return [];
    }
    return [this.takeChunk()];
  }

  flush(): PcmWavRecordingChunk[] {
    return this.bufferedBytes > 0 ? [this.takeChunk()] : [];
  }

  private takeChunk(): PcmWavRecordingChunk {
    if (this.chunkStartMs === undefined || this.chunkEndMs === undefined || this.bufferedBytes === 0) {
      throw new Error("PCM WAV recorder has no buffered audio");
    }
    const chunk: PcmWavRecordingChunk = {
      index: this.nextChunkIndex,
      startMs: this.chunkStartMs,
      endMs: this.chunkEndMs,
      audio: createPcm16MonoWav(Buffer.concat(this.pcmParts, this.bufferedBytes), this.options.sampleRateHz)
    };
    this.nextChunkIndex += 1;
    this.pcmParts.length = 0;
    this.bufferedBytes = 0;
    this.chunkStartMs = undefined;
    this.chunkEndMs = undefined;
    return chunk;
  }
}

function parsePcm16MonoWav(audio: Buffer, expectedSampleRateHz: number): Buffer {
  const bytes = Buffer.from(audio);
  if (
    bytes.byteLength < 46
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.toString("ascii", 12, 16) !== "fmt "
    || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1
    || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== expectedSampleRateHz
    || bytes.readUInt16LE(34) !== 16
    || bytes.toString("ascii", 36, 40) !== "data"
    || bytes.readUInt32LE(40) !== bytes.byteLength - 44
  ) {
    throw new Error(`Recording segment must be ${expectedSampleRateHz} Hz mono PCM16 WAV`);
  }
  return bytes.subarray(44);
}

function createPcm16MonoWav(pcm: Buffer, sampleRateHz: number): Buffer {
  const wav = Buffer.allocUnsafe(44 + pcm.byteLength);
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
  pcm.copy(wav, 44);
  return wav;
}

function validateTimeline(segment: PcmWavRecordingSegment, previousEndMs: number | undefined): void {
  if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
    || segment.startMs < 0 || segment.endMs <= segment.startMs) {
    throw new Error("Recording segment has an invalid timeline");
  }
  if (previousEndMs !== undefined && segment.startMs < previousEndMs) {
    throw new Error("Recording segments must be time ordered and non-overlapping");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
