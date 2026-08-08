import type { ProviderId } from "../config/providers.js";

export interface ImagePayload {
  /** Base64-encoded image payload, without the data URI prefix. */
  base64: string;
  mimeType: string;
}

export interface CompletionRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  prompt: string;
  /** Omit for a text-only request. */
  image?: ImagePayload;
  maxTokens?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  extractText: (payload: unknown) => string;
}

export function textFromGeminiShape(payload: unknown): string {
  const parts =
    (payload as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
      .candidates?.[0]?.content?.parts ?? [];
  return parts.map((part) => part.text ?? "").join("");
}

function textFromOpenAiShape(payload: unknown): string {
  const choice = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === "string") return content;

  // Some OpenAI-compatible providers return content as an array of parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null ? String((part as { text?: string }).text ?? "") : ""))
      .join("");
  }

  return "";
}

function buildRequest(req: CompletionRequest): ProviderRequest {
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const image = req.image;

  const openAiCompatibleBody = (tokenField: "max_tokens" | "max_completion_tokens") => ({
    model: req.model,
    [tokenField]: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: req.prompt },
          ...(image
            ? [
                {
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
                },
              ]
            : []),
        ],
      },
    ],
  });

  switch (req.provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${req.apiKey}`,
        },
        // Newer OpenAI models reject max_tokens and require max_completion_tokens.
        body: openAiCompatibleBody("max_completion_tokens"),
        extractText: textFromOpenAiShape,
      };

    case "xai":
      return {
        url: "https://api.x.ai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${req.apiKey}`,
        },
        body: openAiCompatibleBody("max_tokens"),
        extractText: textFromOpenAiShape,
      };

    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": req.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: req.model,
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: req.prompt },
                ...(image
                  ? [
                      {
                        type: "image",
                        source: { type: "base64", media_type: image.mimeType, data: image.base64 },
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
        extractText: (payload) => {
          const blocks = (payload as { content?: { type?: string; text?: string }[] }).content ?? [];
          return blocks
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("");
        },
      };

    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": req.apiKey,
        },
        body: {
          contents: [
            {
              parts: [
                { text: req.prompt },
                ...(image
                  ? [{ inline_data: { mime_type: image.mimeType, data: image.base64 } }]
                  : []),
              ],
            },
          ],
          generationConfig: { maxOutputTokens: maxTokens },
        },
        extractText: textFromGeminiShape,
      };
  }
}

function describeHttpError(provider: ProviderId, status: number, body: string): string {
  const detail = body.slice(0, 400).trim();

  if (status === 401 || status === 403) {
    return `${provider} rejected the API key (HTTP ${status}). Check it under Configuration > Credentials.`;
  }
  if (status === 404) {
    return `${provider} does not recognize this model (HTTP 404). Pick a different model under Configuration > Default AI model.${detail ? `\n${detail}` : ""}`;
  }
  if (status === 429) {
    return `${provider} rate limit reached (HTTP 429). Try again or lower the concurrency.`;
  }
  return `${provider} request failed (HTTP ${status}).${detail ? `\n${detail}` : ""}`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PostOptions {
  provider: ProviderId;
  url: string;
  headers: Record<string, string>;
  /** A JSON string for the chat endpoints, or FormData for a file upload. */
  body: string | FormData;
  timeoutMs?: number;
}

/**
 * POSTs to a provider and returns the parsed JSON body. Transient failures are
 * retried with exponential backoff; authentication and unknown-model errors
 * fail immediately because retrying them only wastes time.
 *
 * Shared by every provider call so the retry policy and the error messages are
 * written once — a transcription that dies on a 429 should read the same as a
 * completion that does.
 */
export async function postWithRetry(options: PostOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: Error = new ProviderError(`${options.provider} request failed.`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(options.url, {
        method: "POST",
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const error = new ProviderError(
          describeHttpError(options.provider, response.status, errorBody),
          response.status
        );

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
          lastError = error;
          await delay(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }

      return (await response.json()) as unknown;
    } catch (err) {
      if (err instanceof ProviderError && !RETRYABLE_STATUS.has(err.status ?? 0)) {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === MAX_ATTEMPTS) break;
      await delay(1000 * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

/**
 * Sends one prompt — optionally with an image — to the given provider and
 * returns the text response.
 */
export async function complete(req: CompletionRequest): Promise<string> {
  const { url, headers, body, extractText } = buildRequest(req);

  const payload = await postWithRetry({
    provider: req.provider,
    url,
    headers,
    body: JSON.stringify(body),
    timeoutMs: req.timeoutMs,
  });

  return extractText(payload).trim();
}
