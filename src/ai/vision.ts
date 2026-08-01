import { complete, ProviderError } from "./client.js";
import type { ProviderId } from "../config/providers.js";

export { ProviderError };

export interface TranscribeImageRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  prompt: string;
  /** Base64-encoded image payload, without the data URI prefix. */
  imageBase64: string;
  mimeType?: string;
  maxTokens?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Sends one image plus a prompt to the given provider and returns the text
 * response.
 */
export async function transcribeImage(req: TranscribeImageRequest): Promise<string> {
  return complete({
    provider: req.provider,
    model: req.model,
    apiKey: req.apiKey,
    prompt: req.prompt,
    image: { base64: req.imageBase64, mimeType: req.mimeType ?? "image/png" },
    maxTokens: req.maxTokens,
    timeoutMs: req.timeoutMs,
  });
}
