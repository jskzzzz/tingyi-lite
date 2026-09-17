import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBinaryBody, RequestBodyTooLargeError } from "../src/server/http";

describe("bounded HTTP request bodies", () => {
  it("reads a body at the declared limit", async () => {
    const request = requestFrom([Buffer.from("abc"), Buffer.from("def")], "6");
    await expect(readBinaryBody(request, 6)).resolves.toEqual(Buffer.from("abcdef"));
  });

  it("rejects a declared body before buffering it", async () => {
    const request = requestFrom([], "7");
    await expect(readBinaryBody(request, 6)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects a chunked body as soon as its running size crosses the limit", async () => {
    const request = requestFrom([Buffer.from("abcd"), Buffer.from("efgh")]);
    await expect(readBinaryBody(request, 6)).rejects.toMatchObject({ maxBytes: 6 });
  });

  it("keeps an error listener while draining an oversized chunked request", async () => {
    const stream = new PassThrough();
    const request = stream as unknown as IncomingMessage;
    request.headers = {};
    const result = readBinaryBody(request, 6);
    stream.write(Buffer.from("oversized"));
    await expect(result).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(() => stream.emit("error", new Error("client reset"))).not.toThrow();
    stream.destroy();
  });
});

function requestFrom(chunks: Buffer[], contentLength?: string): IncomingMessage {
  const request = Readable.from(chunks) as IncomingMessage;
  request.headers = contentLength ? { "content-length": contentLength } : {};
  return request;
}
