import { readFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createSilentPcm16MonoWav,
  DEFAULT_WINDOWS_WASAPI_LOOPBACK_SEGMENT_MS,
  startWindowsWasapiLoopback,
  type WindowsWasapiLoopbackSegment,
  type WindowsWasapiLoopbackStream
} from "../src/capture/windowsWasapiLoopback";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function segment(id: string, startMs: number, endMs: number): WindowsWasapiLoopbackSegment {
  return {
    id,
    startMs,
    endMs,
    rms: 0.12,
    audio: createSilentPcm16MonoWav(endMs - startMs)
  };
}

describe("startWindowsWasapiLoopback", () => {
  it("waits for stream readiness, reads ahead, and processes callbacks sequentially", async () => {
    const opened = deferred<WindowsWasapiLoopbackStream>();
    const thirdRead = deferred<WindowsWasapiLoopbackSegment | null>();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    const thirdReadStarted = deferred<void>();
    const producerFailure = new AbortController();
    let readCount = 0;
    const stream: WindowsWasapiLoopbackStream = {
      failureSignal: producerFailure.signal,
      readSegment: vi.fn(() => {
        readCount += 1;
        if (readCount === 1) {
          return Promise.resolve(segment("first", 0, 450));
        }
        if (readCount === 2) {
          return Promise.resolve(segment("second", 450, 900));
        }
        thirdReadStarted.resolve();
        return thirdRead.promise;
      }),
      stop: vi.fn(async () => {
        thirdRead.resolve(null);
      })
    };
    let factoryReturned = false;
    const onSegment = vi.fn(async (item: WindowsWasapiLoopbackSegment) => {
      expect(factoryReturned).toBe(true);
      if (item.id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        secondStarted.resolve();
      }
    });
    const openStream = vi.fn(() => opened.promise);

    let startSettled = false;
    const starting = startWindowsWasapiLoopback({ onSegment, openStream });
    void starting.then(() => {
      startSettled = true;
    });
    await Promise.resolve();
    expect(startSettled).toBe(false);
    expect(onSegment).not.toHaveBeenCalled();

    opened.resolve(stream);
    const session = await starting;
    factoryReturned = true;
    expect(openStream).toHaveBeenCalledWith({
      segmentDurationMs: DEFAULT_WINDOWS_WASAPI_LOOPBACK_SEGMENT_MS,
      sampleRateHz: 24_000,
      startupTimeoutMs: 15_000,
      stopTimeoutMs: 10_000
    });
    expect(stream.readSegment).not.toHaveBeenCalled();

    await firstStarted.promise;
    await thirdReadStarted.promise;
    expect(stream.readSegment).toHaveBeenCalledTimes(3);
    expect(onSegment.mock.calls.map(([item]) => item.id)).toEqual(["first"]);
    releaseFirst.resolve();
    await secondStarted.promise;
    expect(onSegment.mock.calls.map(([item]) => item.id)).toEqual(["first", "second"]);

    await session.stop();
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(getEventListeners(producerFailure.signal, "abort")).toHaveLength(0);
  });

  it("buffers more than eight captured segments during a short callback stall without losing order", async () => {
    const releaseFirst = deferred<void>();
    const producerWaiting = deferred<void>();
    const lastDelivered = deferred<void>();
    const completed = deferred<WindowsWasapiLoopbackSegment | null>();
    const segments = Array.from({ length: 12 }, (_, index) => segment(
      `buffered-${index + 1}`,
      index * 450,
      (index + 1) * 450
    ));
    let readIndex = 0;
    const stream: WindowsWasapiLoopbackStream = {
      readSegment: vi.fn(() => {
        if (readIndex < segments.length) {
          return Promise.resolve(segments[readIndex++]);
        }
        producerWaiting.resolve();
        return completed.promise;
      }),
      stop: vi.fn(async () => completed.resolve(null))
    };
    const delivered: string[] = [];
    const session = await startWindowsWasapiLoopback({
      openStream: async () => stream,
      onSegment: async (item) => {
        delivered.push(item.id);
        if (item.id === "buffered-1") {
          await releaseFirst.promise;
        }
        if (item.id === "buffered-12") {
          lastDelivered.resolve();
        }
      }
    });

    await producerWaiting.promise;
    expect(stream.readSegment).toHaveBeenCalledTimes(13);
    expect(delivered).toEqual(["buffered-1"]);
    releaseFirst.resolve();
    await lastDelivered.promise;
    expect(delivered).toEqual(segments.map((item) => item.id));
    await session.stop();
  });

  it("fails explicitly when the callback backlog exceeds its bounded duration", async () => {
    const releaseCallback = deferred<void>();
    const errorReported = deferred<Error>();
    const segments = [
      segment("first", 0, 450),
      segment("second", 450, 900),
      segment("overflow", 900, 1_350)
    ];
    let readIndex = 0;
    const stream: WindowsWasapiLoopbackStream = {
      readSegment: vi.fn(async () => segments[readIndex++] ?? null),
      stop: vi.fn(async () => undefined)
    };
    const session = await startWindowsWasapiLoopback({
      openStream: async () => stream,
      maxCallbackBacklogMs: 900,
      onSegment: async () => releaseCallback.promise,
      onError: (error) => errorReported.resolve(error)
    });

    await expect(errorReported.promise).resolves.toEqual(expect.objectContaining({
      message: "WASAPI render loopback callback backlog exceeded 900 ms"
    }));
    await expect(session.stop()).rejects.toThrow("callback backlog exceeded 900 ms");
    releaseCallback.resolve();
  });

  it("stops the stream first, drains its tail segment, and is idempotent", async () => {
    const tailStarted = deferred<void>();
    const releaseTail = deferred<void>();
    let readCount = 0;
    const order: string[] = [];
    const stream: WindowsWasapiLoopbackStream = {
      readSegment: vi.fn(async () => {
        readCount += 1;
        return readCount === 1 ? segment("tail", 0, 450) : null;
      }),
      stop: vi.fn(async () => {
        order.push("stream.stop");
      })
    };
    const session = await startWindowsWasapiLoopback({
      openStream: async () => stream,
      onSegment: async (item) => {
        order.push(`segment:${item.id}`);
        tailStarted.resolve();
        await releaseTail.promise;
      }
    });

    let stopSettled = false;
    const stopping = session.stop();
    void stopping.then(() => {
      stopSettled = true;
    });
    expect(stream.stop).toHaveBeenCalledTimes(1);
    await tailStarted.promise;
    expect(order).toEqual(["stream.stop", "segment:tail"]);
    expect(stopSettled).toBe(false);

    releaseTail.resolve();
    await stopping;
    await session.stop();
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(stream.readSegment).toHaveBeenCalledTimes(2);
  });

  it("terminates the stream and reports an onSegment failure through onError and stop", async () => {
    const errorReported = deferred<Error>();
    const errorCallbackStopped = deferred<void>();
    const failure = new Error("caption submission failed");
    const stream: WindowsWasapiLoopbackStream = {
      readSegment: vi.fn(async () => segment("failed", 0, 450)),
      stop: vi.fn(async () => undefined)
    };
    let session!: Awaited<ReturnType<typeof startWindowsWasapiLoopback>>;
    session = await startWindowsWasapiLoopback({
      openStream: async () => stream,
      onSegment: async () => {
        throw failure;
      },
      onError: async (error) => {
        errorReported.resolve(error);
        await session.stop().catch(() => undefined);
        errorCallbackStopped.resolve();
      }
    });

    await expect(errorReported.promise).resolves.toBe(failure);
    await errorCallbackStopped.promise;
    await expect(session.stop()).rejects.toBe(failure);
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it("reports stream startup failures before rejecting the factory", async () => {
    const failure = new Error("ready failed");
    const onError = vi.fn(async () => undefined);

    await expect(startWindowsWasapiLoopback({
      openStream: async () => {
        throw failure;
      },
      onSegment: async () => undefined,
      onError
    })).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("times out callback drain instead of hanging stop forever", async () => {
    const callbackStarted = deferred<void>();
    const releaseCallback = deferred<void>();
    const callbackFinished = deferred<void>();
    const pendingRead = deferred<WindowsWasapiLoopbackSegment | null>();
    let readCount = 0;
    const stream: WindowsWasapiLoopbackStream = {
      readSegment: vi.fn(async () => {
        readCount += 1;
        return readCount === 1 ? segment("blocked", 0, 450) : pendingRead.promise;
      }),
      stop: vi.fn(async () => pendingRead.resolve(null))
    };
    const session = await startWindowsWasapiLoopback({
      openStream: async () => stream,
      callbackDrainTimeoutMs: 25,
      onSegment: async () => {
        callbackStarted.resolve();
        await releaseCallback.promise;
        callbackFinished.resolve();
      }
    });
    await callbackStarted.promise;

    await expect(session.stop()).rejects.toThrow("callback drain timed out");
    releaseCallback.resolve();
    await callbackFinished.promise;
    await Promise.resolve();
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(stream.readSegment).toHaveBeenCalledTimes(2);
  });

  it("reports a producer overload while a segment callback is still pending", async () => {
    const callbackStarted = deferred<void>();
    const releaseCallback = deferred<void>();
    const callbackFinished = deferred<void>();
    const producerFailure = new AbortController();
    const errorReported = deferred<Error>();
    const pendingRead = deferred<WindowsWasapiLoopbackSegment | null>();
    const overload = new Error("WASAPI render loopback consumer exceeded 8 queued segments");
    let readCount = 0;
    const stream: WindowsWasapiLoopbackStream = {
      failureSignal: producerFailure.signal,
      readSegment: vi.fn(async () => {
        readCount += 1;
        return readCount === 1 ? segment("slow", 0, 450) : pendingRead.promise;
      }),
      stop: vi.fn(async () => pendingRead.resolve(null))
    };
    const session = await startWindowsWasapiLoopback({
      openStream: async () => stream,
      onSegment: async () => {
        callbackStarted.resolve();
        await releaseCallback.promise;
        callbackFinished.resolve();
      },
      onError: (error) => {
        errorReported.resolve(error);
      }
    });
    await callbackStarted.promise;

    producerFailure.abort(overload);
    await expect(errorReported.promise).resolves.toBe(overload);
    await expect(session.stop()).rejects.toBe(overload);
    releaseCallback.resolve();
    await callbackFinished.promise;
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(stream.readSegment).toHaveBeenCalledTimes(2);
  });

  it("creates a default 450 ms 24 kHz mono PCM16 silence WAV", () => {
    const wav = createSilentPcm16MonoWav();
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(24_000 * 2 * 0.45);
    expect(wav.subarray(44).every((value) => value === 0)).toBe(true);
  });

  it("launches the native helper without PowerShell or a hidden window", async () => {
    const source = await readFile(new URL("../src/capture/windowsWasapiLoopback.ts", import.meta.url), "utf8");
    expect(source).toContain("TingyiLite.WasapiLoopbackHelper.exe");
    expect(source).not.toContain('spawn("pwsh');
    expect(source).not.toContain("Add-Type");
    expect(source).toContain("windowsHide: false");
  });
});
