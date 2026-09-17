import { describe, expect, it } from "vitest";
import { ExternalCaptionProcessAdapter, parseExternalCaptionLine, parseExternalCaptionPreviewLine, parseExternalCaptionStatusLine } from "../src/capture/externalCaptionAdapter";

describe("parseExternalCaptionLine", () => {
  it("accepts plain text helper output", () => {
    expect(parseExternalCaptionLine("  Hello from Live Captions  ")).toEqual({
      text: "Hello from Live Captions"
    });
  });

  it("accepts JSON caption helper output", () => {
    expect(parseExternalCaptionLine('{"type":"caption","text":"System caption","startMs":10,"endMs":900,"language":"en"}')).toEqual({
      text: "System caption",
      startMs: 10,
      endMs: 900,
      isFinal: undefined,
      language: "en"
    });
  });

  it("ignores non-caption JSON helper events", () => {
    expect(parseExternalCaptionLine('{"type":"status","text":"ready"}')).toBeNull();
    expect(parseExternalCaptionLine("   ")).toBeNull();
  });

  it("parses helper status diagnostics without treating them as captions", () => {
    expect(parseExternalCaptionStatusLine('{"type":"status","ok":false,"status":"unavailable","error":"Live Captions permission denied"}')).toEqual({
      ok: false,
      status: "unavailable",
      error: "Live Captions permission denied"
    });
    expect(parseExternalCaptionStatusLine('{"type":"caption","text":"hello"}')).toBeNull();
  });

  it("strictly validates transient preview records", () => {
    expect(parseExternalCaptionPreviewLine('{"type":"caption.preview","action":"upsert","revision":3,"text":"  Live words  ","startMs":10,"endMs":900,"language":"en"}')).toEqual({
      action: "upsert",
      revision: 3,
      text: "Live words",
      startMs: 10,
      endMs: 900,
      language: "en"
    });
    expect(parseExternalCaptionPreviewLine('{"type":"caption.preview","action":"clear","revision":4}')).toEqual({ action: "clear", revision: 4 });
    expect(parseExternalCaptionPreviewLine('{"type":"caption","text":"final"}')).toBeNull();
    expect(() => parseExternalCaptionPreviewLine('{"type":"caption.preview","action":"upsert","revision":0,"text":"bad","startMs":0,"endMs":1,"language":"en"}')).toThrow("revision");
    expect(() => parseExternalCaptionPreviewLine('{"type":"caption.preview","action":"upsert","revision":1,"text":"bad","startMs":10,"endMs":1,"language":"en"}')).toThrow("time range");
    expect(() => parseExternalCaptionPreviewLine('{"type":"caption.preview","action":"upsert","revision":1,"text":"bad","startMs":0,"endMs":1,"language":"fr"}')).toThrow("language");
  });
});

describe("ExternalCaptionProcessAdapter", () => {
  it("reads caption lines from an external process", async () => {
    const captions: Array<{ text: string; startMs?: number; endMs?: number }> = [];
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'caption',text:'System helper caption',startMs:10,endMs:900}))"
      ]
    });

    const result = await new Promise<{ code: number | null; captionCount: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        adapter.stop();
        reject(new Error("caption helper timed out"));
      }, 3000);
      adapter.start({
        onCaption: (caption) => {
          captions.push(caption);
        },
        onError: reject,
        onExit: (exit) => {
          clearTimeout(timer);
          resolve(exit);
        }
      });
    });

    expect(result.code).toBe(0);
    expect(result.captionCount).toBe(1);
    expect(captions).toMatchObject([
      {
        text: "System helper caption",
        startMs: 10,
        endMs: 900
      }
    ]);
  });

  it("drains the final caption callback before reporting process exit", async () => {
    const order: string[] = [];
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({type:'caption',text:'Final line without newline'}))"
      ]
    });

    const result = await new Promise<{ captionCount: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        adapter.stop();
        reject(new Error("caption helper timed out"));
      }, 3000);
      adapter.start({
        onCaption: async () => {
          await new Promise((done) => setTimeout(done, 30));
          order.push("caption");
        },
        onError: reject,
        onExit: (exit) => {
          clearTimeout(timer);
          order.push("exit");
          resolve(exit);
        }
      });
    });

    expect(result.captionCount).toBe(1);
    expect(order).toEqual(["caption", "exit"]);
  });

  it("serializes preview callbacks after preceding durable captions and ignores stale revisions", async () => {
    const order: string[] = [];
    const diagnostics: string[] = [];
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'caption',text:'Durable'}));console.log(JSON.stringify({type:'caption.preview',action:'upsert',revision:2,text:'Next',startMs:0,endMs:100,language:'en'}));console.log(JSON.stringify({type:'caption.preview',action:'clear',revision:1}))"
      ]
    });

    await new Promise<void>((resolve, reject) => {
      adapter.start({
        onCaption: async () => {
          await new Promise((done) => setTimeout(done, 20));
          order.push("caption");
        },
        onPreview: (preview) => {
          order.push(`preview:${preview.revision}`);
        },
        onError: (error) => {
          diagnostics.push(error.message);
        },
        onExit: () => resolve()
      });
      setTimeout(() => reject(new Error("caption helper timed out")), 3000).unref();
    });

    expect(order).toEqual(["caption", "preview:2"]);
    expect(diagnostics).toContain("caption.preview revision 1 is not greater than 2");
  });

  it("waits for a buffered final caption when stop is intentional", async () => {
    const order: string[] = [];
    let sawStatus = false;
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: [
        "-e",
        // Status line and the newline-less caption tail go out in one write: observing the status
        // proves the tail bytes already reached this process, so the test never depends on the
        // helper winning a wall-clock race against stop() on a loaded machine.
        "process.stdout.write(JSON.stringify({type:'status',ok:true,status:'ready'})+'\\n'+JSON.stringify({type:'caption',text:'Buffered before stop'}));setInterval(()=>{},1000)"
      ]
    });
    adapter.start({
      onStatus: () => {
        sawStatus = true;
      },
      onCaption: async () => {
        await new Promise((done) => setTimeout(done, 30));
        order.push("caption");
      },
      onExit: () => {
        order.push("exit");
      }
    });

    await waitFor(() => sawStatus, "the helper status line");
    const result = await adapter.stop();

    expect(result?.captionCount).toBe(1);
    expect(order).toEqual(["caption", "exit"]);
  });

  it("waits for a helper to flush after a graceful stop command", async () => {
    const captions: string[] = [];
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.setEncoding('utf8');process.stdin.once('data',(line)=>{const message=JSON.parse(line);if(message.type==='stop'){console.log(JSON.stringify({type:'caption',text:'Flushed tail'}));process.exit(0)}});setInterval(()=>{},1000)"
      ],
      gracefulStopInput: JSON.stringify({ type: "stop" }),
      gracefulStopTimeoutMs: 1000
    });
    adapter.start({
      onCaption: (caption) => {
        captions.push(caption.text);
      }
    });

    const result = await adapter.stop();

    expect(result?.code).toBe(0);
    expect(result?.captionCount).toBe(1);
    expect(captions).toEqual(["Flushed tail"]);
  });

  it("surfaces a status error before reporting exit", async () => {
    const diagnostics: string[] = [];
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'status',ok:false,status:'unavailable',error:'permission denied'}))"
      ]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        adapter.stop();
        reject(new Error("caption helper timed out"));
      }, 3000);
      adapter.start({
        onCaption: () => reject(new Error("status diagnostic became a caption")),
        onError: (error) => {
          diagnostics.push(error.message);
        },
        onExit: () => {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    expect(diagnostics).toEqual(["permission denied"]);
  });

  it("rejects the drain when a caption persistence callback fails", async () => {
    const diagnostics: string[] = [];
    const previews: string[] = [];
    let exitProcessingError: string | undefined;
    let sawStatus = false;
    const adapter = new ExternalCaptionProcessAdapter({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'status',ok:true,status:'ready'})+'\\n'+JSON.stringify({type:'caption',text:'Cannot persist'})+'\\n'+JSON.stringify({type:'caption.preview',action:'upsert',revision:1,text:'Must not leak',startMs:0,endMs:1,language:'en'})+'\\n');setInterval(()=>{},1000)"]
    });
    adapter.start({
      onStatus: () => {
        sawStatus = true;
      },
      onCaption: async () => {
        throw new Error("event store write failed");
      },
      onPreview: (preview) => {
        if (preview.action === "upsert") {
          previews.push(preview.text);
        }
      },
      onError: (error) => {
        diagnostics.push(error.message);
      },
      onExit: (result) => {
        exitProcessingError = result.processingError?.message;
      }
    });

    await waitFor(() => sawStatus, "the helper status line");
    await expect(adapter.stop()).rejects.toThrow("event store write failed");
    expect(exitProcessingError).toBe("event store write failed");
    expect(diagnostics).toContain("event store write failed");
    expect(previews).toEqual([]);
  });
});

/**
 * Wait for an observable helper signal instead of sleeping a fixed amount: the helper is a separate
 * process that gets starved on a loaded machine, so wall-clock waits make these tests flaky.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
