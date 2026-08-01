export type ProviderId = "openai" | "anthropic" | "google" | "xai";

export interface ModelInfo {
  /** Model identifier sent to the provider API. */
  id: string;
  label: string;
  /** Whether the model accepts image input. Tools that send images require this. */
  vision: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Environment variable used as a fallback when no key is stored in the config. */
  envVar: string;
  /** Shown as a placeholder when prompting for the key. */
  keyPlaceholder: string;
  keysUrl: string;
  models: ModelInfo[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    keyPlaceholder: "sk-proj-...",
    keysUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5", label: "GPT-5", vision: true },
      { id: "gpt-4.1", label: "GPT-4.1", vision: true },
      { id: "gpt-4o", label: "GPT-4o", vision: true },
      { id: "gpt-4o-mini", label: "GPT-4o mini", vision: true },
    ],
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    envVar: "ANTHROPIC_API_KEY",
    keyPlaceholder: "sk-ant-...",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5", vision: true },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", vision: true },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", vision: true },
    ],
  },
  {
    id: "google",
    label: "Google (Gemini)",
    envVar: "GEMINI_API_KEY",
    keyPlaceholder: "AIza...",
    keysUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", vision: true },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", vision: true },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", vision: true },
    ],
  },
  {
    id: "xai",
    label: "Grok (xAI)",
    envVar: "XAI_API_KEY",
    keyPlaceholder: "xai-...",
    keysUrl: "https://console.x.ai",
    models: [
      { id: "grok-4", label: "Grok 4", vision: true },
      { id: "grok-2-vision-1212", label: "Grok 2 Vision", vision: true },
    ],
  },
];

export function getProvider(id: ProviderId): ProviderInfo {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}

/**
 * Model lists go stale as providers ship new models, so a model saved in the
 * config may not be in the registry. Fall back to the raw id in that case.
 */
export function getModelLabel(providerId: ProviderId, modelId: string): string {
  const model = getProvider(providerId).models.find((m) => m.id === modelId);
  return model?.label ?? modelId;
}
