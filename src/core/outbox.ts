import { createOutboxId } from "./ids";
import { sha256Hex, stableJson } from "./hash";
import type { LiteEvent, SyncOutboxItem } from "./schema";

export async function createOutboxItem(input: {
  deviceId: string;
  endpoint?: string;
  event: LiteEvent;
  now: Date;
}): Promise<SyncOutboxItem> {
  const contentHash = await sha256Hex(stableJson(input.event));
  return {
    schemaVersion: 1,
    outboxId: createOutboxId(input.deviceId, input.event.cursor),
    deviceId: input.deviceId,
    localCursor: input.event.cursor,
    contentHash,
    endpoint: input.endpoint,
    status: "pending",
    event: input.event,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    attemptCount: 0
  };
}
