import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;
export const DEFAULT_BINARY_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
  }
}

export class InvalidJsonBodyError extends Error {
  constructor(message = "Request body must be valid JSON") {
    super(message);
  }
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const text = await readTextBody(request, DEFAULT_JSON_BODY_LIMIT_BYTES);
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export async function readBinaryBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_BINARY_BODY_LIMIT_BYTES
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    drainRequest(request);
    throw new RequestBodyTooLargeError(maxBytes);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cleanup();
        drainRequest(request);
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };
    const onAborted = () => fail(new Error("Request body was aborted"));
    const onError = (error: Error) => fail(error);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function drainRequest(request: IncomingMessage): void {
  if (request.readableEnded || request.destroyed) {
    return;
  }
  const ignoreError = () => undefined;
  const cleanup = () => {
    request.off("error", ignoreError);
    request.off("end", cleanup);
    request.off("close", cleanup);
  };
  request.on("error", ignoreError);
  request.once("end", cleanup);
  request.once("close", cleanup);
  request.resume();
}

async function readTextBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const bytes = await readBinaryBody(request, maxBytes);
  return bytes.toString("utf8");
}

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}

export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

export function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { ok: false, error: message });
}
