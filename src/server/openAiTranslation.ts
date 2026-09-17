export interface TranslationModelRequest {
  text: string;
  previousText?: string;
  signal?: AbortSignal;
}

export interface TranslationModel {
  readonly model: string;
  translate(request: TranslationModelRequest): Promise<string>;
}

export interface OpenAiTranslationModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TRANSLATION_TIMEOUT_MS = 30_000;
const TRANSLATION_PLACEHOLDERS = new Set(["中文译文", "译文", "翻译", "翻译结果", "中文翻译", "字幕译文"]);

export class TranslationModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationModelError";
  }
}

export class OpenAiTranslationModel implements TranslationModel {
  readonly model: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAiTranslationModelConfig) {
    this.apiKey = requiredTrimmed(config.apiKey, "translation API key");
    this.model = requiredTrimmed(config.model, "translation model");
    this.endpoint = chatCompletionsEndpoint(requiredTrimmed(config.baseUrl, "translation base URL"));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 86_400_000) {
      throw new Error("translation timeout must be an integer between 1000 and 86400000");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async translate(request: TranslationModelRequest): Promise<string> {
    const text = request.text.replace(/\s+/g, " ").trim();
    if (!text) {
      throw new TranslationModelError("Translation source text is empty");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Translation model request timed out")), this.timeoutMs);
    const abortFromCaller = () => controller.abort(request.signal?.reason ?? new Error("Translation model request aborted"));
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (request.signal?.aborted) {
      abortFromCaller();
    }

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "api-key": this.apiKey,
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "system",
                content: [
                  "你是实时英语字幕的简体中文翻译器。",
                  "完整翻译当前字幕，表达自然、简洁，不补写原文没有的信息。",
                  "上一句只用于理解上下文，不得并入当前译文。",
                  "只输出 JSON 对象，且只能包含 translation 字段。"
                ].join("\n")
              },
              {
                role: "user",
                content: JSON.stringify({
                  previousCaption: request.previousText?.replace(/\s+/g, " ").trim() || "",
                  currentCaption: text
                })
              }
            ],
            response_format: { type: "json_object" },
            temperature: 0,
            max_tokens: 512
          })
        });
      } catch {
        const aborted = controller.signal.aborted;
        throw new TranslationModelError(aborted
          ? request.signal?.aborted
            ? "Translation model request aborted"
            : "Translation model request timed out"
          : "Translation model network request failed");
      }

      const responseText = await response.text();
      if (!response.ok) {
        throw new TranslationModelError(`Translation model returned HTTP ${response.status}`);
      }
      return parseTranslationResponse(responseText, text);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function parseTranslationResponse(responseText: string, sourceText: string): string {
  let response: unknown;
  try {
    response = JSON.parse(responseText) as unknown;
  } catch {
    throw new TranslationModelError("Translation model response is not valid JSON");
  }
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length === 0) {
    throw new TranslationModelError("Translation model response is missing choices");
  }
  const choice = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") {
    throw new TranslationModelError("Translation model response is missing message content");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(choice.message.content) as unknown;
  } catch {
    throw new TranslationModelError("Translation model content is not valid JSON");
  }
  if (!isRecord(payload) || Object.keys(payload).length !== 1 || typeof payload.translation !== "string") {
    throw new TranslationModelError("Translation model content must contain only a string translation field");
  }
  const translated = payload.translation.replace(/\s+/g, " ").trim();
  if (!translated) {
    throw new TranslationModelError("Translation model returned an empty translation");
  }
  const normalizedTranslation = translated.replace(/[\s，。！？、；：“”‘’（）《》:,.!?;'"`()\[\]{}<>-]/gu, "");
  if (TRANSLATION_PLACEHOLDERS.has(normalizedTranslation)) {
    throw new TranslationModelError("Translation model returned placeholder text");
  }
  if (translated.toLocaleLowerCase() === sourceText.replace(/\s+/g, " ").trim().toLocaleLowerCase()) {
    throw new TranslationModelError("Translation model returned the untranslated source text");
  }
  if (/[A-Za-z]/.test(sourceText) && !/[\u3400-\u9fff]/u.test(translated)) {
    throw new TranslationModelError("Translation model did not return Chinese text");
  }
  return translated;
}

function chatCompletionsEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("translation base URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("translation base URL must use HTTPS or loopback HTTP");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function requiredTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
