import type { AudioChunkRecord } from "../core/schema";
import type { SessionTailDisposition } from "./api";

export type RecordingFlushPhase =
  | "recording"
  | "stop_requested"
  | "flush_uncertain"
  | "tail_durable"
  | "loss_confirmed"
  | "end_pending";

export interface DurableAudioUploadJob {
  chunkId: string;
  sessionId: string;
  sourceId: string;
  blob: Blob;
  mimeType: string;
  startMs: number;
  endMs: number;
  attempt: number;
  createdAt: number;
  lastError?: string;
}

export interface DurableRecordingState {
  sessionId: string;
  sourceId: string;
  phase: RecordingFlushPhase;
  endDisposition?: Exclude<SessionTailDisposition, "not-recording">;
  updatedAt: number;
}

export interface AudioUploadQueueStore {
  putJob(job: DurableAudioUploadJob): Promise<void>;
  listJobs(sessionId?: string): Promise<DurableAudioUploadJob[]>;
  deleteJob(chunkId: string): Promise<void>;
  putRecording(recording: DurableRecordingState): Promise<void>;
  getRecording(sessionId: string): Promise<DurableRecordingState | undefined>;
  listRecordings(): Promise<DurableRecordingState[]>;
  deleteRecording(sessionId: string): Promise<void>;
}

export interface AudioUploadQueueSnapshot {
  pendingUploads: number;
  blockedUploads: number;
  uploading: boolean;
  recordings: DurableRecordingState[];
}

export interface AudioUploadCoordinatorOptions {
  maxAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
  chunkIdFactory?: () => string;
  now?: () => number;
  onSnapshot?: (snapshot: AudioUploadQueueSnapshot) => void;
  onUploaded?: (chunk: AudioChunkRecord) => void;
}

export interface EnqueueAudioChunkInput {
  sessionId: string;
  sourceId: string;
  blob: Blob;
  startMs: number;
  endMs: number;
}

export class RecordingFlushUncertainError extends Error {
  constructor(sessionId: string) {
    super(`Recording tail is uncertain for session ${sessionId}`);
    this.name = "RecordingFlushUncertainError";
  }
}

export class AudioUploadBlockedError extends Error {
  constructor(public readonly job: DurableAudioUploadJob) {
    super(`Audio upload is blocked for chunk ${job.chunkId}: ${job.lastError ?? "upload failed"}`);
    this.name = "AudioUploadBlockedError";
  }
}

export class AudioUploadCoordinator {
  private readonly maxAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly chunkIdFactory: () => string;
  private readonly now: () => number;
  private readonly onSnapshot?: (snapshot: AudioUploadQueueSnapshot) => void;
  private readonly onUploaded?: (chunk: AudioChunkRecord) => void;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly failedWrites = new Map<string, unknown>();
  private readonly drains = new Map<string, Promise<void>>();
  private snapshotRequest = 0;
  private snapshotPublished = 0;

  constructor(
    private readonly store: AudioUploadQueueStore,
    private readonly upload: (job: DurableAudioUploadJob) => Promise<AudioChunkRecord>,
    options: AudioUploadCoordinatorOptions = {}
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.chunkIdFactory = options.chunkIdFactory ?? createAudioChunkId;
    this.now = options.now ?? Date.now;
    this.onSnapshot = options.onSnapshot;
    this.onUploaded = options.onUploaded;
  }

  async initialize(): Promise<AudioUploadQueueSnapshot> {
    const recordings = await this.store.listRecordings();
    for (const recording of recordings) {
      if (recording.phase === "recording" || recording.phase === "stop_requested") {
        await this.store.putRecording({
          ...recording,
          phase: "flush_uncertain",
          updatedAt: this.now()
        });
      }
    }
    const snapshot = await this.publishSnapshot();
    for (const sessionId of new Set((await this.store.listJobs()).map((job) => job.sessionId))) {
      void this.drainSession(sessionId).catch(() => undefined);
    }
    return snapshot;
  }

  async beginRecording(sessionId: string, sourceId: string): Promise<void> {
    await this.writeTail;
    const current = await this.store.getRecording(sessionId);
    if (current) {
      throw new Error(`Recording state already exists for session ${sessionId}: ${current.phase}`);
    }
    this.failedWrites.delete(sessionId);
    await this.store.putRecording({
      sessionId,
      sourceId,
      phase: "recording",
      updatedAt: this.now()
    });
    await this.publishSnapshot();
  }

  async enqueueChunk(input: EnqueueAudioChunkInput): Promise<DurableAudioUploadJob> {
    const job: DurableAudioUploadJob = {
      chunkId: this.chunkIdFactory(),
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      blob: input.blob,
      mimeType: input.blob.type || "application/octet-stream",
      startMs: input.startMs,
      endMs: input.endMs,
      attempt: 0,
      createdAt: this.now()
    };
    const write = this.queueWrite(async () => {
      try {
        const recording = await this.store.getRecording(input.sessionId);
        if (!recording || (recording.phase !== "recording" && recording.phase !== "stop_requested")) {
          throw new Error(`Cannot persist audio for session ${input.sessionId} in phase ${recording?.phase ?? "missing"}`);
        }
        await this.store.putJob(job);
      } catch (error) {
        this.failedWrites.set(input.sessionId, error);
        throw error;
      }
      await this.publishSnapshot();
    });
    void write
      .then(() => this.drainSession(input.sessionId))
      .catch(() => undefined);
    await write;
    return job;
  }

  async requestStop(sessionId: string): Promise<void> {
    await this.writeTail;
    const recording = await this.requireRecording(sessionId);
    if (recording.phase !== "recording") {
      throw new Error(`Cannot request stop for session ${sessionId} in phase ${recording.phase}`);
    }
    if (this.failedWrites.has(sessionId)) {
      const failedWrite = this.failedWrites.get(sessionId);
      await this.persistFlushUncertain(recording);
      throw failedWrite;
    }
    try {
      await this.store.putRecording({
        ...recording,
        phase: "stop_requested",
        updatedAt: this.now()
      });
    } catch (error) {
      await this.persistFlushUncertain(recording);
      throw error;
    }
    await this.publishSnapshot();
  }

  async markTailDurable(sessionId: string): Promise<void> {
    await this.writeTail;
    const recording = await this.requireRecording(sessionId);
    if (recording.phase !== "stop_requested") {
      throw new Error(`Cannot mark recording tail durable for session ${sessionId} in phase ${recording.phase}`);
    }
    if (this.failedWrites.has(sessionId)) {
      const failedWrite = this.failedWrites.get(sessionId);
      await this.persistFlushUncertain(recording);
      throw failedWrite;
    }
    try {
      await this.store.putRecording({
        ...recording,
        phase: "tail_durable",
        updatedAt: this.now()
      });
    } catch (error) {
      await this.persistFlushUncertain(recording);
      throw error;
    }
    await this.publishSnapshot();
  }

  async markUnexpectedStop(sessionId: string): Promise<void> {
    await this.writeTail;
    const recording = await this.store.getRecording(sessionId);
    if (!recording || recording.phase !== "recording") {
      return;
    }
    await this.store.putRecording({
      ...recording,
      phase: "flush_uncertain",
      updatedAt: this.now()
    });
    await this.publishSnapshot();
  }

  async markStopFailed(sessionId: string): Promise<void> {
    try {
      await this.writeTail;
    } catch {
      // A failed final write is itself the reason the tail cannot be declared durable.
    }
    const recording = await this.store.getRecording(sessionId);
    if (!recording || (recording.phase !== "recording" && recording.phase !== "stop_requested")) {
      return;
    }
    await this.store.putRecording({
      ...recording,
      phase: "flush_uncertain",
      updatedAt: this.now()
    });
    await this.publishSnapshot();
  }

  async confirmUncertainTailLoss(sessionId: string): Promise<void> {
    await this.writeTail;
    const recording = await this.requireRecording(sessionId);
    if (recording.phase !== "flush_uncertain") {
      throw new Error(`Cannot confirm uncertain tail for session ${sessionId} in phase ${recording.phase}`);
    }
    await this.store.putRecording({
      ...recording,
      phase: "loss_confirmed",
      updatedAt: this.now()
    });
    this.failedWrites.delete(sessionId);
    await this.publishSnapshot();
  }

  async finalizeSession(sessionId: string, end: (tailDisposition: SessionTailDisposition) => Promise<unknown>): Promise<void> {
    await this.writeTail;
    const recording = await this.store.getRecording(sessionId);
    if (recording && (recording.phase === "recording" || recording.phase === "stop_requested" || recording.phase === "flush_uncertain")) {
      throw new RecordingFlushUncertainError(sessionId);
    }
    await this.drainSession(sessionId);
    if ((await this.store.listJobs(sessionId)).length > 0) {
      throw new Error(`Audio uploads are still pending for session ${sessionId}`);
    }
    const tailDisposition = recordingTailDisposition(recording);
    if (recording?.phase === "tail_durable" || recording?.phase === "loss_confirmed") {
      await this.store.putRecording({
        ...recording,
        phase: "end_pending",
        endDisposition: tailDisposition === "not-recording" ? undefined : tailDisposition,
        updatedAt: this.now()
      });
      await this.publishSnapshot();
    }
    await end(tailDisposition);
    if (recording) {
      await this.store.deleteRecording(sessionId);
      this.failedWrites.delete(sessionId);
      await this.publishSnapshot();
    }
  }

  async retryPendingUploads(sessionId?: string): Promise<void> {
    await this.writeTail;
    const jobs = await this.store.listJobs(sessionId);
    for (const job of jobs) {
      if (job.attempt > 0 || job.lastError) {
        await this.store.putJob({ ...job, attempt: 0, lastError: undefined });
      }
    }
    await this.publishSnapshot();
    if (sessionId) {
      await this.drainSession(sessionId);
      return;
    }
    for (const currentSessionId of new Set(jobs.map((job) => job.sessionId))) {
      await this.drainSession(currentSessionId);
    }
  }

  async getSnapshot(): Promise<AudioUploadQueueSnapshot> {
    return this.createSnapshot();
  }

  async acknowledgeSessionEnded(sessionId: string): Promise<void> {
    await this.writeTail;
    await this.drainSession(sessionId);
    if ((await this.store.listJobs(sessionId)).length > 0) {
      return;
    }
    if (await this.store.getRecording(sessionId)) {
      await this.store.deleteRecording(sessionId);
      this.failedWrites.delete(sessionId);
      await this.publishSnapshot();
    }
  }

  private async drainSession(sessionId: string): Promise<void> {
    const current = this.drains.get(sessionId);
    if (current) {
      await current;
      await this.drainSession(sessionId);
      return;
    }
    const drain = this.performDrain(sessionId).finally(() => {
      this.drains.delete(sessionId);
      void this.publishSnapshot();
    });
    this.drains.set(sessionId, drain);
    await this.publishSnapshot();
    await drain;
  }

  private async performDrain(sessionId: string): Promise<void> {
    while (true) {
      const job = (await this.store.listJobs(sessionId))[0];
      if (!job) {
        return;
      }
      if (job.attempt >= this.maxAttempts) {
        throw new AudioUploadBlockedError(job);
      }
      try {
        const chunk = await this.upload(job);
        await this.store.deleteJob(job.chunkId);
        this.onUploaded?.(chunk);
        await this.publishSnapshot();
      } catch (error) {
        if (error instanceof AudioUploadBlockedError) {
          throw error;
        }
        const failedJob = {
          ...job,
          attempt: job.attempt + 1,
          lastError: error instanceof Error ? error.message : String(error)
        };
        await this.store.putJob(failedJob);
        await this.publishSnapshot();
        if (failedJob.attempt >= this.maxAttempts) {
          throw new AudioUploadBlockedError(failedJob);
        }
        await this.retryDelay(failedJob.attempt);
      }
    }
  }

  private async requireRecording(sessionId: string): Promise<DurableRecordingState> {
    const recording = await this.store.getRecording(sessionId);
    if (!recording) {
      throw new Error(`Recording state does not exist for session ${sessionId}`);
    }
    return recording;
  }

  private queueWrite(operation: () => Promise<void>): Promise<void> {
    const write = this.writeTail.then(operation);
    this.writeTail = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  }

  private async persistFlushUncertain(recording: DurableRecordingState): Promise<void> {
    await this.store.putRecording({
      ...recording,
      phase: "flush_uncertain",
      updatedAt: this.now()
    });
    await this.publishSnapshot();
  }

  private async publishSnapshot(): Promise<AudioUploadQueueSnapshot> {
    const request = ++this.snapshotRequest;
    const snapshot = await this.createSnapshot();
    if (request > this.snapshotPublished) {
      this.snapshotPublished = request;
      this.onSnapshot?.(snapshot);
    }
    return snapshot;
  }

  private async createSnapshot(): Promise<AudioUploadQueueSnapshot> {
    const [jobs, recordings] = await Promise.all([this.store.listJobs(), this.store.listRecordings()]);
    return {
      pendingUploads: jobs.length,
      blockedUploads: jobs.filter((job) => job.attempt >= this.maxAttempts).length,
      uploading: this.drains.size > 0,
      recordings: recordings.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
    };
  }
}

export async function stopMediaRecorderAndPersistTail(
  recorder: MediaRecorder,
  coordinator: AudioUploadCoordinator,
  sessionId: string
): Promise<void> {
  try {
    await coordinator.requestStop(sessionId);
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener("error", () => reject(new Error("MediaRecorder stopped with an error")), { once: true });
    });
    recorder.requestData();
    recorder.stop();
    await stopped;
    await coordinator.markTailDurable(sessionId);
  } catch (error) {
    await coordinator.markStopFailed(sessionId);
    throw error;
  }
}

export class IndexedDbAudioUploadQueueStore implements AudioUploadQueueStore {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async putJob(job: DurableAudioUploadJob): Promise<void> {
    await this.write(JOBS_STORE, (store) => store.put(job));
  }

  async listJobs(sessionId?: string): Promise<DurableAudioUploadJob[]> {
    const jobs = await this.readAll<DurableAudioUploadJob>(JOBS_STORE);
    return jobs
      .filter((job) => !sessionId || job.sessionId === sessionId)
      .sort((left, right) => left.startMs - right.startMs || left.createdAt - right.createdAt || left.chunkId.localeCompare(right.chunkId));
  }

  async deleteJob(chunkId: string): Promise<void> {
    await this.write(JOBS_STORE, (store) => store.delete(chunkId));
  }

  async putRecording(recording: DurableRecordingState): Promise<void> {
    await this.write(RECORDINGS_STORE, (store) => store.put(recording));
  }

  async getRecording(sessionId: string): Promise<DurableRecordingState | undefined> {
    const database = await this.open();
    const transaction = database.transaction(RECORDINGS_STORE, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult<DurableRecordingState | undefined>(transaction.objectStore(RECORDINGS_STORE).get(sessionId));
    await done;
    return value;
  }

  async listRecordings(): Promise<DurableRecordingState[]> {
    return this.readAll<DurableRecordingState>(RECORDINGS_STORE);
  }

  async deleteRecording(sessionId: string): Promise<void> {
    await this.write(RECORDINGS_STORE, (store) => store.delete(sessionId));
  }

  private async readAll<T>(storeName: string): Promise<T[]> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult<T[]>(transaction.objectStore(storeName).getAll());
    await done;
    return values;
  }

  private async write(storeName: string, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    operation(transaction.objectStore(storeName));
    await transactionDone(transaction);
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(JOBS_STORE)) {
            database.createObjectStore(JOBS_STORE, { keyPath: "chunkId" });
          }
          if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
            database.createObjectStore(RECORDINGS_STORE, { keyPath: "sessionId" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Failed to open the audio upload database"));
        request.onblocked = () => reject(new Error("Audio upload database upgrade is blocked"));
      });
    }
    return this.database;
  }
}

export function createAudioChunkId(): string {
  return `audio_${crypto.randomUUID()}`;
}

const DATABASE_NAME = "tingyi-lite-audio-upload";
const DATABASE_VERSION = 1;
const JOBS_STORE = "jobs";
const RECORDINGS_STORE = "recordings";

function defaultRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 5000)));
}

function recordingTailDisposition(recording: DurableRecordingState | undefined): SessionTailDisposition {
  if (!recording) {
    return "not-recording";
  }
  if (recording.phase === "tail_durable") {
    return "durable";
  }
  if (recording.phase === "loss_confirmed") {
    return "loss-confirmed";
  }
  if (recording.phase === "end_pending" && recording.endDisposition) {
    return recording.endDisposition;
  }
  throw new Error(`Recording tail disposition is missing for session ${recording.sessionId} in phase ${recording.phase}`);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}
