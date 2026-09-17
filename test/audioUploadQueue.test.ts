import { describe, expect, it, vi } from "vitest";
import type { AudioChunkRecord } from "../src/core/schema";
import {
  AudioUploadBlockedError,
  AudioUploadCoordinator,
  RecordingFlushUncertainError,
  stopMediaRecorderAndPersistTail,
  type AudioUploadQueueStore,
  type DurableAudioUploadJob,
  type DurableRecordingState
} from "../src/web/audioUploadQueue";
import { endSession, uploadAudioChunk } from "../src/web/api";

describe("durable browser audio queue", () => {
  it("persists a client-generated chunk id before completing its upload", async () => {
    const store = new MemoryAudioUploadQueueStore();
    const uploadGate = deferred<AudioChunkRecord>();
    const uploadStarted = deferred<DurableAudioUploadJob>();
    const coordinator = new AudioUploadCoordinator(
      store,
      async (job) => {
        uploadStarted.resolve(job);
        return uploadGate.promise;
      },
      {
        chunkIdFactory: () => "audio_client_stable_1",
        now: () => 100
      }
    );

    await coordinator.beginRecording("session_1", "source_1");
    const job = await coordinator.enqueueChunk({
      sessionId: "session_1",
      sourceId: "source_1",
      blob: new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/webm" }),
      startMs: 0,
      endMs: 5000
    });
    expect(job.chunkId).toBe("audio_client_stable_1");
    expect((await uploadStarted.promise).chunkId).toBe("audio_client_stable_1");
    expect((await store.listJobs("session_1"))[0]).toEqual(expect.objectContaining({
      chunkId: "audio_client_stable_1",
      mimeType: "audio/webm",
      attempt: 0
    }));

    uploadGate.resolve(audioChunk("audio_client_stable_1"));
    await coordinator.retryPendingUploads("session_1");
    expect(await store.listJobs("session_1")).toEqual([]);
  });

  it("does not mark the recorder tail durable until every final IndexedDB write completes", async () => {
    const store = new DelayedJobStore();
    const coordinator = new AudioUploadCoordinator(store, async (job) => audioChunk(job.chunkId), {
      chunkIdFactory: () => "audio_final_tail",
      retryDelay: async () => undefined
    });
    await coordinator.beginRecording("session_tail", "source_tail");
    store.blockNextJobWrite();
    const requestDataCalled = deferred<void>();
    const callbacks = new Map<string, () => void>();
    let write: Promise<DurableAudioUploadJob> | undefined;
    const recorder = {
      addEventListener: (type: string, callback: () => void) => callbacks.set(type, callback),
      requestData: () => {
        write = coordinator.enqueueChunk({
          sessionId: "session_tail",
          sourceId: "source_tail",
          blob: new Blob([Uint8Array.from([9])], { type: "audio/webm" }),
          startMs: 5000,
          endMs: 5100
        });
        requestDataCalled.resolve();
      },
      stop: () => callbacks.get("stop")?.()
    } as unknown as MediaRecorder;
    let durable = false;
    const stop = stopMediaRecorderAndPersistTail(recorder, coordinator, "session_tail").then(() => {
      durable = true;
    });
    await requestDataCalled.promise;
    expect(durable).toBe(false);
    expect((await store.getRecording("session_tail"))?.phase).toBe("stop_requested");

    store.releaseJobWrite();
    await write;
    await stop;
    expect((await store.getRecording("session_tail"))?.phase).toBe("tail_durable");
  });

  it("recovers the serialized write queue after one rejected store write", async () => {
    const store = new FaultInjectingAudioUploadQueueStore();
    const blocked = deferred<void>();
    let uploadAvailable = false;
    let chunkSequence = 0;
    const coordinator = new AudioUploadCoordinator(
      store,
      async (current) => {
        if (!uploadAvailable) {
          throw new Error("offline");
        }
        return audioChunk(current.chunkId);
      },
      {
        maxAttempts: 1,
        chunkIdFactory: () => `audio_write_recovery_${++chunkSequence}`,
        retryDelay: async () => undefined,
        onSnapshot: (snapshot) => {
          if (snapshot.blockedUploads === 1) {
            blocked.resolve();
          }
        }
      }
    );
    await coordinator.beginRecording("session_write_recovery", "source_write_recovery");

    store.failNextJobWrite();
    await expect(coordinator.enqueueChunk({
      sessionId: "session_write_recovery",
      sourceId: "source_write_recovery",
      blob: new Blob([Uint8Array.from([1])], { type: "audio/webm" }),
      startMs: 0,
      endMs: 100
    })).rejects.toThrow("injected job write failure");

    const recoveredJob = await coordinator.enqueueChunk({
      sessionId: "session_write_recovery",
      sourceId: "source_write_recovery",
      blob: new Blob([Uint8Array.from([2])], { type: "audio/webm" }),
      startMs: 100,
      endMs: 200
    });
    expect(recoveredJob.chunkId).toBe("audio_write_recovery_2");
    await blocked.promise;

    const recorder = immediateStopRecorder();
    await expect(stopMediaRecorderAndPersistTail(recorder, coordinator, "session_write_recovery"))
      .rejects.toThrow("injected job write failure");
    expect((await store.getRecording("session_write_recovery"))?.phase).toBe("flush_uncertain");

    uploadAvailable = true;
    await coordinator.retryPendingUploads("session_write_recovery");
    expect(await store.listJobs("session_write_recovery")).toEqual([]);
    await coordinator.confirmUncertainTailLoss("session_write_recovery");
    const end = vi.fn(async () => undefined);
    await coordinator.finalizeSession("session_write_recovery", end);
    expect(end).toHaveBeenCalledWith("loss-confirmed");
    expect(await store.getRecording("session_write_recovery")).toBeUndefined();
  });

  it("keeps the tail fail-closed when the recording read before a chunk write fails", async () => {
    const store = new FaultInjectingAudioUploadQueueStore();
    const coordinator = new AudioUploadCoordinator(store, async (current) => audioChunk(current.chunkId));
    await coordinator.beginRecording("session_read_failure", "source_read_failure");
    store.failNextRecordingRead();

    await expect(coordinator.enqueueChunk({
      sessionId: "session_read_failure",
      sourceId: "source_read_failure",
      blob: new Blob([Uint8Array.from([1])], { type: "audio/webm" }),
      startMs: 0,
      endMs: 100
    })).rejects.toThrow("injected recording read failure");

    await expect(stopMediaRecorderAndPersistTail(
      immediateStopRecorder(),
      coordinator,
      "session_read_failure"
    )).rejects.toThrow("injected recording read failure");
    expect((await store.getRecording("session_read_failure"))?.phase).toBe("flush_uncertain");
  });

  it("moves a failed requestStop write to flush_uncertain and remains recoverable", async () => {
    const store = new FaultInjectingAudioUploadQueueStore();
    const coordinator = new AudioUploadCoordinator(store, async (current) => audioChunk(current.chunkId));
    await coordinator.beginRecording("session_stop_write_failure", "source_stop_write_failure");
    store.failNextRecordingWrite("stop_requested");
    const recorder = immediateStopRecorder();

    await expect(stopMediaRecorderAndPersistTail(recorder, coordinator, "session_stop_write_failure"))
      .rejects.toThrow("injected recording write failure: stop_requested");
    expect((await store.getRecording("session_stop_write_failure"))?.phase).toBe("flush_uncertain");

    await coordinator.confirmUncertainTailLoss("session_stop_write_failure");
    const end = vi.fn(async () => undefined);
    await coordinator.finalizeSession("session_stop_write_failure", end);
    expect(end).toHaveBeenCalledWith("loss-confirmed");
  });

  it("moves a failed tail_durable write to flush_uncertain and remains recoverable", async () => {
    const store = new FaultInjectingAudioUploadQueueStore();
    const coordinator = new AudioUploadCoordinator(store, async (current) => audioChunk(current.chunkId));
    await coordinator.beginRecording("session_tail_write_failure", "source_tail_write_failure");
    store.failNextRecordingWrite("tail_durable");

    await expect(stopMediaRecorderAndPersistTail(
      immediateStopRecorder(),
      coordinator,
      "session_tail_write_failure"
    )).rejects.toThrow("injected recording write failure: tail_durable");
    expect((await store.getRecording("session_tail_write_failure"))?.phase).toBe("flush_uncertain");

    await coordinator.confirmUncertainTailLoss("session_tail_write_failure");
    const end = vi.fn(async () => undefined);
    await coordinator.finalizeSession("session_tail_write_failure", end);
    expect(end).toHaveBeenCalledWith("loss-confirmed");
  });

  it("turns recording and stop_requested reloads into flush_uncertain and blocks implicit end", async () => {
    const store = new MemoryAudioUploadQueueStore();
    await store.putRecording(recording("session_recording", "recording", 1));
    await store.putRecording(recording("session_stopping", "stop_requested", 2));
    const coordinator = new AudioUploadCoordinator(store, async (job) => audioChunk(job.chunkId), { now: () => 10 });

    const snapshot = await coordinator.initialize();
    expect(snapshot.recordings.map((item) => [item.sessionId, item.phase])).toEqual([
      ["session_recording", "flush_uncertain"],
      ["session_stopping", "flush_uncertain"]
    ]);
    const end = vi.fn(async () => undefined);
    await expect(coordinator.finalizeSession("session_recording", end)).rejects.toBeInstanceOf(RecordingFlushUncertainError);
    expect(end).not.toHaveBeenCalled();
    await coordinator.confirmUncertainTailLoss("session_recording");
    expect((await store.getRecording("session_recording"))?.phase).toBe("loss_confirmed");
    await coordinator.finalizeSession("session_recording", end);
    expect(end).toHaveBeenCalledWith("loss-confirmed");
  });

  it("marks an in-page recorder stop failure as flush_uncertain immediately", async () => {
    const store = new MemoryAudioUploadQueueStore();
    const coordinator = new AudioUploadCoordinator(store, async (current) => audioChunk(current.chunkId));
    await coordinator.beginRecording("session_stop_error", "source_stop_error");
    const recorder = {
      addEventListener: () => undefined,
      requestData: () => {
        throw new DOMException("recorder became inactive", "InvalidStateError");
      },
      stop: () => undefined
    } as unknown as MediaRecorder;

    await expect(stopMediaRecorderAndPersistTail(recorder, coordinator, "session_stop_error")).rejects.toThrow("recorder became inactive");
    expect((await store.getRecording("session_stop_error"))?.phase).toBe("flush_uncertain");
  });

  it("drains durable jobs before persisting end_pending and calling the end endpoint", async () => {
    const log: string[] = [];
    const store = new LoggingAudioUploadQueueStore(log);
    await store.putRecording(recording("session_end", "tail_durable", 1));
    await store.putJob(job("audio_end"));
    log.length = 0;
    const coordinator = new AudioUploadCoordinator(
      store,
      async (current) => {
        log.push(`upload:${current.chunkId}`);
        return audioChunk(current.chunkId);
      }
    );

    await coordinator.finalizeSession("session_end", async (tailDisposition) => {
      log.push(`end:${tailDisposition}`);
    });

    expect(log).toEqual([
      "upload:audio_end",
      "delete-job:audio_end",
      "phase:end_pending",
      "end:durable",
      "delete-recording:session_end"
    ]);
  });

  it("retains the durable tail disposition when an end request must be retried", async () => {
    const store = new MemoryAudioUploadQueueStore();
    await store.putRecording(recording("session_end_retry", "tail_durable", 1));
    const coordinator = new AudioUploadCoordinator(store, async (current) => audioChunk(current.chunkId));
    await expect(coordinator.finalizeSession("session_end_retry", async () => {
      throw new Error("connection reset");
    })).rejects.toThrow("connection reset");
    expect(await store.getRecording("session_end_retry")).toEqual(expect.objectContaining({
      phase: "end_pending",
      endDisposition: "durable"
    }));

    const retried: string[] = [];
    const recoveredCoordinator = new AudioUploadCoordinator(store, async (current) => audioChunk(current.chunkId));
    await recoveredCoordinator.initialize();
    await recoveredCoordinator.finalizeSession("session_end_retry", async (tailDisposition) => {
      retried.push(tailDisposition);
    });
    expect(retried).toEqual(["durable"]);
    expect(await store.getRecording("session_end_retry")).toBeUndefined();
  });

  it("keeps a failed job durable and retries it without changing its chunk id", async () => {
    const store = new MemoryAudioUploadQueueStore();
    let shouldFail = true;
    const blocked = deferred<void>();
    let attempts = 0;
    const coordinator = new AudioUploadCoordinator(
      store,
      async (current) => {
        attempts += 1;
        if (shouldFail) {
          throw new Error("offline");
        }
        return audioChunk(current.chunkId);
      },
      {
        maxAttempts: 2,
        chunkIdFactory: () => "audio_retry_same_id",
        retryDelay: async () => undefined,
        onSnapshot: (snapshot) => {
          if (snapshot.blockedUploads === 1) {
            blocked.resolve();
          }
        }
      }
    );
    await coordinator.beginRecording("session_retry", "source_retry");
    await coordinator.enqueueChunk({
      sessionId: "session_retry",
      sourceId: "source_retry",
      blob: new Blob([Uint8Array.from([4, 5])], { type: "audio/webm" }),
      startMs: 0,
      endMs: 100
    });
    await blocked.promise;
    const failed = (await store.listJobs("session_retry"))[0];
    expect(failed).toEqual(expect.objectContaining({
      chunkId: "audio_retry_same_id",
      attempt: 2,
      lastError: "offline"
    }));
    await expect(coordinator.finalizeSession("session_retry", async () => undefined)).rejects.toBeInstanceOf(RecordingFlushUncertainError);

    shouldFail = false;
    await coordinator.retryPendingUploads("session_retry");
    expect(await store.listJobs("session_retry")).toEqual([]);
  });
});

describe("browser audio API", () => {
  it("uses the idempotent PUT path with the stable client chunk id", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      chunk: audioChunk("audio_client_put")
    }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await uploadAudioChunk({
        chunkId: "audio_client_put",
        sessionId: "session_put",
        sourceId: "source_put",
        blob: new Blob([Uint8Array.from([1])], { type: "audio/webm" }),
        startMs: 100,
        endMs: 200
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/audio-chunks/session_put/audio_client_put?sourceId=source_put&startMs=100&endMs=200");
      expect(init).toEqual(expect.objectContaining({
        method: "PUT",
        body: expect.any(Blob),
        headers: expect.objectContaining({ "content-type": "audio/webm" })
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends the explicit recording-tail disposition when ending a session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      session: { sessionId: "session_end_api" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await endSession("session_end_api", "loss-confirmed");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/sessions/session_end_api/end");
      expect(init).toEqual(expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tailDisposition: "loss-confirmed" }),
        headers: expect.objectContaining({ "content-type": "application/json" })
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

class MemoryAudioUploadQueueStore implements AudioUploadQueueStore {
  protected readonly jobs = new Map<string, DurableAudioUploadJob>();
  protected readonly recordings = new Map<string, DurableRecordingState>();

  async putJob(current: DurableAudioUploadJob): Promise<void> {
    this.jobs.set(current.chunkId, current);
  }

  async listJobs(sessionId?: string): Promise<DurableAudioUploadJob[]> {
    return [...this.jobs.values()]
      .filter((current) => !sessionId || current.sessionId === sessionId)
      .sort((left, right) => left.startMs - right.startMs || left.createdAt - right.createdAt || left.chunkId.localeCompare(right.chunkId));
  }

  async deleteJob(chunkId: string): Promise<void> {
    this.jobs.delete(chunkId);
  }

  async putRecording(current: DurableRecordingState): Promise<void> {
    this.recordings.set(current.sessionId, current);
  }

  async getRecording(sessionId: string): Promise<DurableRecordingState | undefined> {
    return this.recordings.get(sessionId);
  }

  async listRecordings(): Promise<DurableRecordingState[]> {
    return [...this.recordings.values()];
  }

  async deleteRecording(sessionId: string): Promise<void> {
    this.recordings.delete(sessionId);
  }
}

class DelayedJobStore extends MemoryAudioUploadQueueStore {
  private jobWriteGate?: ReturnType<typeof deferred<void>>;

  blockNextJobWrite(): void {
    this.jobWriteGate = deferred<void>();
  }

  releaseJobWrite(): void {
    this.jobWriteGate?.resolve();
  }

  override async putJob(current: DurableAudioUploadJob): Promise<void> {
    const gate = this.jobWriteGate;
    if (gate) {
      await gate.promise;
      if (this.jobWriteGate === gate) {
        this.jobWriteGate = undefined;
      }
    }
    await super.putJob(current);
  }
}

class FaultInjectingAudioUploadQueueStore extends MemoryAudioUploadQueueStore {
  private rejectJobWrite = false;
  private rejectRecordingRead = false;
  private rejectedRecordingPhase?: DurableRecordingState["phase"];

  failNextJobWrite(): void {
    this.rejectJobWrite = true;
  }

  failNextRecordingWrite(phase: DurableRecordingState["phase"]): void {
    this.rejectedRecordingPhase = phase;
  }

  failNextRecordingRead(): void {
    this.rejectRecordingRead = true;
  }

  override async putJob(current: DurableAudioUploadJob): Promise<void> {
    if (this.rejectJobWrite) {
      this.rejectJobWrite = false;
      throw new Error("injected job write failure");
    }
    await super.putJob(current);
  }

  override async putRecording(current: DurableRecordingState): Promise<void> {
    if (this.rejectedRecordingPhase === current.phase) {
      this.rejectedRecordingPhase = undefined;
      throw new Error(`injected recording write failure: ${current.phase}`);
    }
    await super.putRecording(current);
  }

  override async getRecording(sessionId: string): Promise<DurableRecordingState | undefined> {
    if (this.rejectRecordingRead) {
      this.rejectRecordingRead = false;
      throw new Error("injected recording read failure");
    }
    return super.getRecording(sessionId);
  }
}

class LoggingAudioUploadQueueStore extends MemoryAudioUploadQueueStore {
  constructor(private readonly log: string[]) {
    super();
  }

  override async putRecording(current: DurableRecordingState): Promise<void> {
    this.log.push(`phase:${current.phase}`);
    await super.putRecording(current);
  }

  override async deleteJob(chunkId: string): Promise<void> {
    this.log.push(`delete-job:${chunkId}`);
    await super.deleteJob(chunkId);
  }

  override async deleteRecording(sessionId: string): Promise<void> {
    this.log.push(`delete-recording:${sessionId}`);
    await super.deleteRecording(sessionId);
  }
}

function job(chunkId: string): DurableAudioUploadJob {
  return {
    chunkId,
    sessionId: "session_end",
    sourceId: "source_end",
    blob: new Blob([Uint8Array.from([1])], { type: "audio/webm" }),
    mimeType: "audio/webm",
    startMs: 0,
    endMs: 10,
    attempt: 0,
    createdAt: 1
  };
}

function recording(sessionId: string, phase: DurableRecordingState["phase"], updatedAt: number): DurableRecordingState {
  return {
    sessionId,
    sourceId: `source_${sessionId}`,
    phase,
    updatedAt
  };
}

function audioChunk(chunkId: string): AudioChunkRecord {
  return {
    schemaVersion: 1,
    chunkId,
    sessionId: "session_test",
    sourceId: "source_test",
    mimeType: "audio/webm",
    byteLength: 3,
    sha256: "a".repeat(64),
    startMs: 0,
    endMs: 10,
    path: `sessions/session_test/audio/${chunkId}.webm`,
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function immediateStopRecorder(): MediaRecorder {
  const callbacks = new Map<string, () => void>();
  return {
    addEventListener: (type: string, callback: () => void) => callbacks.set(type, callback),
    requestData: () => undefined,
    stop: () => callbacks.get("stop")?.()
  } as unknown as MediaRecorder;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
