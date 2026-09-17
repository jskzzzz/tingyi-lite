import type { CaptionSourcePreference, LiteSettings, MemosSettings, TranslationPreferences } from "./schema";

export const DEFAULT_LITE_SETTINGS: LiteSettings = {
  schemaVersion: 1,
  captionSource: "local-asr",
  localAsrEngineId: "moonshine-tiny-en"
};

export const DEFAULT_TRANSLATION_PREFERENCES: TranslationPreferences = {
  schemaVersion: 1,
  enabled: false
};

export const DEFAULT_MEMOS_TIMEOUT_MS = 30_000;

export function memosSettingsValidationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Memos settings must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["baseUrl", "schemaVersion", "timeoutMs", "token", "visibility"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return "Memos settings must contain only schemaVersion, baseUrl, token, visibility and timeoutMs";
  }
  if (record.schemaVersion !== 1) {
    return "Unsupported Memos settings schemaVersion";
  }
  if (typeof record.baseUrl !== "string" || !record.baseUrl.trim()) {
    return "baseUrl must be a non-empty string";
  }
  if (typeof record.token !== "string" || !record.token.trim()) {
    return "token must be a non-empty string";
  }
  if (record.visibility !== "PRIVATE" && record.visibility !== "PROTECTED" && record.visibility !== "PUBLIC") {
    return "visibility must be PRIVATE, PROTECTED or PUBLIC";
  }
  if (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 1_000 || (record.timeoutMs as number) > 86_400_000) {
    return "timeoutMs must be an integer between 1000 and 86400000";
  }
  return undefined;
}

export function isCaptionSourcePreference(value: unknown): value is CaptionSourcePreference {
  return value === "system-captions" || value === "local-asr";
}

export function isLocalAsrEngineId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export function liteSettingsValidationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Settings must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "captionSource" || keys[1] !== "localAsrEngineId" || keys[2] !== "schemaVersion") {
    return "Settings must contain only schemaVersion, captionSource and localAsrEngineId";
  }
  if (record.schemaVersion !== 1) {
    return "Unsupported settings schemaVersion";
  }
  if (!isCaptionSourcePreference(record.captionSource)) {
    return "captionSource must be system-captions or local-asr";
  }
  if (!isLocalAsrEngineId(record.localAsrEngineId)) {
    return "localAsrEngineId must be a lowercase engine identifier";
  }
  return undefined;
}

export function translationPreferencesValidationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Translation preferences must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "enabled" || keys[1] !== "schemaVersion") {
    return "Translation preferences must contain only schemaVersion and enabled";
  }
  if (record.schemaVersion !== 1) {
    return "Unsupported translation preferences schemaVersion";
  }
  if (typeof record.enabled !== "boolean") {
    return "enabled must be a boolean";
  }
  return undefined;
}

export function translationModelSettingsValidationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Translation model settings must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["apiKey", "baseUrl", "model", "schemaVersion", "timeoutMs"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return "Translation model settings must contain only schemaVersion, apiKey, baseUrl, model and timeoutMs";
  }
  if (record.schemaVersion !== 1) {
    return "Unsupported translation model settings schemaVersion";
  }
  for (const key of ["apiKey", "baseUrl", "model"] as const) {
    if (typeof record[key] !== "string" || !record[key].trim()) {
      return `${key} must be a non-empty string`;
    }
  }
  if (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 1_000 || (record.timeoutMs as number) > 86_400_000) {
    return "timeoutMs must be an integer between 1000 and 86400000";
  }
  return undefined;
}
