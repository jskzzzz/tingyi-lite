import { sha256Hex, stableJson } from "./hash";
import { createOutboxId, isValidDeviceId } from "./ids";
import { liteEventValidationError } from "./eventValidation";
import type { SyncOutboxItem } from "./schema";

export async function syncOutboxItemValidationError(value: unknown): Promise<string | undefined> {
  if (!isRecord(value)) {
    return "Invalid outbox item";
  }
  if (value.schemaVersion !== 1) {
    return "Unsupported outbox schemaVersion";
  }
  if (typeof value.outboxId !== "string" || !/^outbox_[A-Za-z0-9_-]+$/.test(value.outboxId)) {
    return "Invalid outboxId";
  }
  if (!isValidDeviceId(value.deviceId)) {
    return "Invalid deviceId";
  }
  if (typeof value.localCursor !== "number" || !Number.isSafeInteger(value.localCursor) || value.localCursor < 1) {
    return "Invalid localCursor";
  }
  if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) {
    return "Invalid contentHash";
  }
  if (value.endpoint !== undefined && (typeof value.endpoint !== "string" || !value.endpoint.trim())) {
    return "Invalid endpoint";
  }
  if (value.status !== "pending" && value.status !== "syncing" && value.status !== "synced" && value.status !== "failed") {
    return "Invalid outbox status";
  }
  const eventError = liteEventValidationError(value.event);
  if (eventError) {
    return `Invalid event: ${eventError}`;
  }
  const item = value as unknown as SyncOutboxItem;
  if (item.outboxId !== createOutboxId(item.deviceId, item.localCursor)) {
    return "outboxId does not match deviceId and localCursor";
  }
  if (item.localCursor !== item.event.cursor) {
    return "localCursor does not match event.cursor";
  }
  const expectedHash = await sha256Hex(stableJson(item.event));
  if (item.contentHash !== expectedHash) {
    return "contentHash does not match event";
  }
  if (!isTimestamp(value.createdAt)) {
    return "Invalid createdAt";
  }
  if (!isTimestamp(value.updatedAt)) {
    return "Invalid updatedAt";
  }
  if (typeof value.attemptCount !== "number" || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0) {
    return "Invalid attemptCount";
  }
  if (value.lastError !== undefined && typeof value.lastError !== "string") {
    return "Invalid lastError";
  }
  return undefined;
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
