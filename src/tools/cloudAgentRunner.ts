import { spawn } from "node:child_process";

export interface CloudAgentRunnerInput {
  baseUrl: string;
  sessionId: string;
  command: string;
  args?: string[];
  token?: string;
  tenantId?: string;
  agentName?: string;
  timeoutMs?: number;
}

export interface CloudAgentRunnerResult {
  status: "generated" | "imported" | "existing";
  material: {
    materialId: string;
    materialHash: string;
    sourceBundleHash: string;
    generator: {
      kind: "baseline" | "external-agent";
      name: string;
    };
  };
}

interface LearningBundleResponse {
  ok: true;
  bundle: {
    schemaVersion: 1;
    product: string;
    bundleHash: string;
    session: {
      sessionId: string;
    };
  };
}

interface LearningMaterialResponse {
  ok: true;
  status: CloudAgentRunnerResult["status"];
  material: CloudAgentRunnerResult["material"];
}

export async function runCloudLearningAgent(input: CloudAgentRunnerInput): Promise<CloudAgentRunnerResult> {
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  const bundle = await getJson<LearningBundleResponse>(
    `${baseUrl}/sessions/${encodeURIComponent(input.sessionId)}/learning-bundle`,
    input.token,
    input.tenantId
  );
  const agentInput = {
    schemaVersion: 1,
    product: "tingyi-lite-agent-input",
    agentName: input.agentName?.trim() || "external-agent",
    bundle: bundle.bundle
  };
  const output = await runAgentCommand({
    command: input.command,
    args: input.args ?? [],
    stdin: JSON.stringify(agentInput),
    timeoutMs: input.timeoutMs ?? 120_000
  });
  const material = parseAgentMaterial(output.stdout);
  const response = await postJson<LearningMaterialResponse>(
    `${baseUrl}/sessions/${encodeURIComponent(input.sessionId)}/learning-materials`,
    input.token,
    input.tenantId,
    { material }
  );
  return {
    status: response.status,
    material: response.material
  };
}

function parseAgentMaterial(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    throw new Error("Agent command produced empty stdout");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Agent command stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isRecord(value) && value.material !== undefined) {
    return value.material;
  }
  return value;
}

async function runAgentCommand(input: {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  if (!input.command.trim()) {
    throw new Error("Agent command is required");
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Agent command timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code !== 0) {
        reject(new Error(`Agent command exited with code ${code}: ${output.stderr.trim()}`));
        return;
      }
      resolve(output);
    });
    child.stdin.end(input.stdin);
  });
}

async function getJson<T>(url: string, token?: string, tenantId?: string): Promise<T> {
  const response = await fetch(url, {
    headers: requestHeaders(token, tenantId)
  });
  return await unwrapJson<T>(response);
}

async function postJson<T>(url: string, token: string | undefined, tenantId: string | undefined, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...requestHeaders(token, tenantId),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return await unwrapJson<T>(response);
}

async function unwrapJson<T>(response: Response): Promise<T> {
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
