import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, transcribeImage } from "../src/ai/vision.js";
import type { ProviderId } from "../src/config/providers.js";

const IMAGE = "aGVsbG8=";

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockFetch(responses: { status: number; payload?: unknown; text?: string }[]): {
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let index = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string),
      });

      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;

      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.payload,
        text: async () => response.text ?? "",
      };
    })
  );

  return { calls };
}

function baseRequest(provider: ProviderId, model: string) {
  return { provider, model, apiKey: "test-key", prompt: "transcribe", imageBase64: IMAGE };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openai requests", () => {
  it("posts to the chat completions endpoint with a bearer token", async () => {
    const { calls } = mockFetch([
      { status: 200, payload: { choices: [{ message: { content: "# Page" } }] } },
    ]);

    const text = await transcribeImage(baseRequest("openai", "gpt-4o"));

    expect(text).toBe("# Page");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
  });

  it("sends the image as a data URI and uses max_completion_tokens", async () => {
    const { calls } = mockFetch([
      { status: 200, payload: { choices: [{ message: { content: "ok" } }] } },
    ]);

    await transcribeImage(baseRequest("openai", "gpt-5"));

    const body = calls[0].body as {
      max_completion_tokens: number;
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.messages[0].content[1].image_url?.url).toBe(`data:image/png;base64,${IMAGE}`);
  });
});

describe("anthropic requests", () => {
  it("uses x-api-key with a version header and a base64 image source", async () => {
    const { calls } = mockFetch([
      { status: 200, payload: { content: [{ type: "text", text: "## Title" }] } },
    ]);

    const text = await transcribeImage(baseRequest("anthropic", "claude-sonnet-5"));

    expect(text).toBe("## Title");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("test-key");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");

    const body = calls[0].body as {
      max_tokens: number;
      messages: { content: { type: string; source?: { data: string; media_type: string } }[] }[];
    };
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages[0].content[1].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: IMAGE,
    });
  });

  it("concatenates only text blocks from the response", async () => {
    mockFetch([
      {
        status: 200,
        payload: {
          content: [
            { type: "thinking", thinking: "ignored" },
            { type: "text", text: "one " },
            { type: "text", text: "two" },
          ],
        },
      },
    ]);

    expect(await transcribeImage(baseRequest("anthropic", "claude-opus-5"))).toBe("one two");
  });
});

describe("google requests", () => {
  it("targets the generateContent endpoint for the model with inline image data", async () => {
    const { calls } = mockFetch([
      { status: 200, payload: { candidates: [{ content: { parts: [{ text: "body" }] } }] } },
    ]);

    const text = await transcribeImage(baseRequest("google", "gemini-2.5-flash"));

    expect(text).toBe("body");
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
    expect(calls[0].headers["x-goog-api-key"]).toBe("test-key");

    const body = calls[0].body as {
      contents: { parts: { inline_data?: { data: string; mime_type: string } }[] }[];
    };
    expect(body.contents[0].parts[1].inline_data).toEqual({
      mime_type: "image/png",
      data: IMAGE,
    });
  });
});

describe("xai requests", () => {
  it("uses the xAI endpoint and max_tokens", async () => {
    const { calls } = mockFetch([
      { status: 200, payload: { choices: [{ message: { content: "grok" } }] } },
    ]);

    await transcribeImage(baseRequest("xai", "grok-4"));

    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect(calls[0].body).toHaveProperty("max_tokens");
    expect(calls[0].body).not.toHaveProperty("max_completion_tokens");
  });
});

describe("error handling", () => {
  it("does not retry an authentication failure and names the provider", async () => {
    const { calls } = mockFetch([{ status: 401, text: "invalid key" }]);

    await expect(transcribeImage(baseRequest("openai", "gpt-4o"))).rejects.toThrow(
      /rejected the API key/
    );
    expect(calls).toHaveLength(1);
  });

  it("points at the model setting when the model is unknown", async () => {
    mockFetch([{ status: 404, text: "model not found" }]);

    await expect(transcribeImage(baseRequest("google", "gemini-nope"))).rejects.toThrow(
      /does not recognize this model/
    );
  });

  it("retries a server error and succeeds when a later attempt works", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch([
      { status: 503, text: "unavailable" },
      { status: 200, payload: { choices: [{ message: { content: "recovered" } }] } },
    ]);

    const promise = transcribeImage(baseRequest("openai", "gpt-4o"));
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  it("gives up after three attempts on persistent rate limiting", async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch([{ status: 429, text: "slow down" }]);

    const promise = transcribeImage(baseRequest("openai", "gpt-4o"));
    const assertion = expect(promise).rejects.toBeInstanceOf(ProviderError);
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(calls).toHaveLength(3);
  });
});
