import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiTranslationModel, TranslationModelError } from "../src/server/openAiTranslation";

describe("OpenAiTranslationModel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends caption text to the configured chat-completions model and returns strict Chinese JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => translationResponse("你好，世界！"));
    const model = new OpenAiTranslationModel({
      apiKey: "translation-secret",
      baseUrl: "https://translation.example.test/v1/",
      model: "translate-model",
      fetchImpl
    });

    await expect(model.translate({ text: "Hello, world!", previousText: "Welcome." })).resolves.toBe("你好，世界！");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://translation.example.test/v1/chat/completions");
    expect(init?.headers).toEqual(expect.objectContaining({
      authorization: "Bearer translation-secret",
      "api-key": "translation-secret"
    }));
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(body.model).toBe("translate-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(body.messages[1]!.content)).toEqual({
      previousCaption: "Welcome.",
      currentCaption: "Hello, world!"
    });
  });

  it.each([
    ["not-json", "response is not valid JSON"],
    [JSON.stringify({ choices: [] }), "response is missing choices"],
    [JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), "content is not valid JSON"],
    [JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation: "" }) } }] }), "empty translation"],
    [JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation: "中文译文" }) } }] }), "placeholder text"],
    [JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation: "Hello" }) } }] }), "untranslated source text"],
    [JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation: "Bonjour" }) } }] }), "did not return Chinese text"]
  ])("rejects an unusable model response", async (responseText, message) => {
    const model = new OpenAiTranslationModel({
      apiKey: "secret",
      baseUrl: "http://127.0.0.1:8999/v1",
      model: "translate-model",
      fetchImpl: async () => new Response(responseText, { status: 200 })
    });

    await expect(model.translate({ text: "Hello" })).rejects.toThrow(message);
  });

  it("reports HTTP failures without exposing the API key or accepting insecure remote HTTP", async () => {
    expect(() => new OpenAiTranslationModel({
      apiKey: "secret",
      baseUrl: "http://translation.example.test/v1",
      model: "translate-model"
    })).toThrow("HTTPS or loopback HTTP");

    const model = new OpenAiTranslationModel({
      apiKey: "do-not-leak-this",
      baseUrl: "https://translation.example.test/v1",
      model: "translate-model",
      fetchImpl: async () => new Response("do-not-leak-this", { status: 401 })
    });
    const error = await model.translate({ text: "Hello" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TranslationModelError);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain("do-not-leak-this");
  });

  it("times out a stalled model request", async () => {
    vi.useFakeTimers();
    const model = new OpenAiTranslationModel({
      apiKey: "secret",
      baseUrl: "http://localhost:8999/v1",
      model: "translate-model",
      timeoutMs: 1_000,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    });

    const request = model.translate({ text: "Hello" });
    const assertion = expect(request).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

function translationResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ translation: text }) } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
}
