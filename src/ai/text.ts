import { complete } from "./client.js";
import type { ProviderId } from "../config/providers.js";

export interface CompleteTextRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** Instructions for the model. */
  prompt: string;
  /** The text the instructions operate on. Appended below the prompt. */
  input: string;
  maxTokens?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Rewriting a document costs roughly as many output tokens as input ones. */
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Sends a text-only prompt to the given provider and returns the response.
 * The input is fenced so the model can tell instructions from content.
 */
export async function completeText(req: CompleteTextRequest): Promise<string> {
  return complete({
    provider: req.provider,
    model: req.model,
    apiKey: req.apiKey,
    prompt: `${req.prompt}\n\n<document>\n${req.input}\n</document>`,
    maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: req.timeoutMs,
  });
}
