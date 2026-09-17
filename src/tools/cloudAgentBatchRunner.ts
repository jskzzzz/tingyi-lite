import { runCloudLearningAgent, type CloudAgentRunnerResult } from "./cloudAgentRunner";

export interface CloudAgentBatchInput {
  baseUrl: string;
  token?: string;
  tenantId?: string;
  agentName?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  apply?: boolean;
  limit?: number;
}

export interface CloudAgentBatchResult {
  ok: true;
  apply: boolean;
  scanned: number;
  eligible: number;
  processed: number;
  skipped: number;
  sessions: CloudAgentBatchSessionResult[];
}

export interface CloudAgentBatchSessionResult {
  sessionId: string;
  title: string;
  readyForLearningAgent: boolean;
  hasCurrentLearningMaterial: boolean;
  issueKeys: string[];
  action: "eligible" | "processed" | "skipped" | "failed";
  reason?: string;
  material?: CloudAgentRunnerResult["material"];
}

interface SessionsResponse {
  ok: true;
  sessions: Array<{
    session: {
      sessionId: string;
      title: string;
    };
  }>;
}

interface AuditResponse {
  ok: true;
  audit: {
    readyForLearningAgent: boolean;
    hasCurrentLearningMaterial: boolean;
    issues: Array<{ key: string }>;
  };
}

export async function runCloudAgentBatch(input: CloudAgentBatchInput): Promise<CloudAgentBatchResult> {
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  const sessions = (await getJson<SessionsResponse>(`${baseUrl}/sessions`, input.token, input.tenantId)).sessions;
  const selected = sessions.slice(0, boundedLimit(input.limit, sessions.length));
  if (input.apply && !input.command?.trim()) {
    throw new Error("command is required when --apply is used");
  }
  const results: CloudAgentBatchSessionResult[] = [];
  for (const item of selected) {
    const sessionId = item.session.sessionId;
    const audit = (await getJson<AuditResponse>(
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/audit`,
      input.token,
      input.tenantId
    )).audit;
    const baseResult = {
      sessionId,
      title: item.session.title,
      readyForLearningAgent: audit.readyForLearningAgent,
      hasCurrentLearningMaterial: audit.hasCurrentLearningMaterial,
      issueKeys: audit.issues.map((issue) => issue.key)
    };
    if (!audit.readyForLearningAgent) {
      results.push({
        ...baseResult,
        action: "skipped",
        reason: audit.issues.length > 0 ? audit.issues.map((issue) => issue.key).join(",") : "not-ready"
      });
      continue;
    }
    if (audit.hasCurrentLearningMaterial) {
      results.push({
        ...baseResult,
        action: "skipped",
        reason: "current-material-exists"
      });
      continue;
    }
    if (!input.apply) {
      results.push({
        ...baseResult,
        action: "eligible",
        reason: "dry-run"
      });
      continue;
    }
    try {
      const result = await runCloudLearningAgent({
        baseUrl,
        sessionId,
        token: input.token,
        tenantId: input.tenantId,
        agentName: input.agentName,
        command: input.command!,
        args: input.args ?? [],
        timeoutMs: input.timeoutMs
      });
      results.push({
        ...baseResult,
        action: "processed",
        material: result.material
      });
    } catch (error) {
      results.push({
        ...baseResult,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    ok: true,
    apply: Boolean(input.apply),
    scanned: selected.length,
    eligible: results.filter((result) => result.action === "eligible" || result.action === "processed" || result.action === "failed").length,
    processed: results.filter((result) => result.action === "processed").length,
    skipped: results.filter((result) => result.action === "skipped").length,
    sessions: results
  };
}

async function getJson<T>(url: string, token?: string, tenantId?: string): Promise<T> {
  const response = await fetch(url, {
    headers: requestHeaders(token, tenantId)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new Error(isRecord(json) && typeof json.error === "string" ? json.error : `HTTP ${response.status}`);
  }
  return json as T;
}

function requestHeaders(token?: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const trimmed = token?.trim();
  if (trimmed) {
    headers.authorization = `Bearer ${trimmed}`;
  }
  const tenant = tenantId?.trim();
  if (tenant) {
    headers["x-tingyi-tenant-id"] = tenant;
  }
  return headers;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(fallback, Math.floor(value)));
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("baseUrl is required");
  }
  return trimmed.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
