import * as p from "@clack/prompts";
import pc from "picocolors";
import { c } from "../utils/logger.js";
import {
  PROVIDERS,
  getModelLabel,
  transcriptionModels,
  type ProviderId,
} from "../config/providers.js";
import {
  configuredProviders,
  loadConfig,
  resolveApiKey,
  setDefaultModel,
} from "../config/store.js";

export interface ResolvedModel {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

/**
 * Resolves which model a tool should use: the configured default when it is
 * usable, otherwise an interactive pick. Returns null when the user cancels or
 * has no credentials configured.
 */
export async function resolveToolModel(): Promise<ResolvedModel | null> {
  const config = await loadConfig();
  const available = configuredProviders(config);

  if (available.length === 0) {
    p.log.error(
      `${c.error("✖ No AI provider configured.")}\n` +
      pc.dim("  Go to Configuration > Credentials and add an API key first.")
    );
    return null;
  }

  const preferred = config.defaultModel;
  if (preferred) {
    const apiKey = resolveApiKey(config, preferred.provider);
    if (apiKey) {
      p.log.info(
        `${c.dim("▸")} Using ${c.highlight(getModelLabel(preferred.provider, preferred.model))} ` +
        pc.dim(`(${preferred.provider})`)
      );
      return { provider: preferred.provider, model: preferred.model, apiKey };
    }

    p.log.warn(
      `${c.warn("⚠")} The default model uses ${preferred.provider}, which has no API key. Pick another.`
    );
  }

  const providerChoice = await p.select({
    message: "Provider",
    options: available.map((id) => ({
      value: id as string,
      label: PROVIDERS.find((item) => item.id === id)?.label ?? id,
    })),
  });
  if (p.isCancel(providerChoice)) return null;

  const provider = providerChoice as ProviderId;
  const info = PROVIDERS.find((item) => item.id === provider);

  const modelChoice = await p.select({
    message: "Model",
    options: (info?.models ?? []).map((model) => ({
      value: model.id,
      label: model.label,
      hint: model.vision ? "vision" : undefined,
    })),
  });
  if (p.isCancel(modelChoice)) return null;

  const model = modelChoice as string;
  const apiKey = resolveApiKey(config, provider);
  if (!apiKey) return null;

  const remember = await p.confirm({
    message: "Save this as the default model for tools?",
    initialValue: true,
  });
  if (!p.isCancel(remember) && remember) {
    await setDefaultModel(provider, model);
  }

  return { provider, model, apiKey };
}

/**
 * Picks a model that can listen to audio, which is a narrower question than
 * resolveToolModel answers: only OpenAI and Google take audio at all, so the
 * saved default is no help — it usually points at a chat model, and may point
 * at a provider with no audio input whatsoever.
 */
export async function resolveTranscriptionModel(): Promise<ResolvedModel | null> {
  const config = await loadConfig();
  const available = configuredProviders(config).filter(
    (id) => transcriptionModels(id).length > 0
  );

  if (available.length === 0) {
    p.log.error(
      `${c.error("✖ No provider that can transcribe audio is configured.")}\n` +
      pc.dim("  Only OpenAI and Google accept audio — Claude and Grok have no audio input.\n") +
      pc.dim("  Add a key for one of them under Configuration > Credentials.")
    );
    return null;
  }

  let provider = available[0];

  if (available.length > 1) {
    const choice = await p.select({
      message: "Transcription provider",
      options: available.map((id) => ({
        value: id as string,
        label: PROVIDERS.find((item) => item.id === id)?.label ?? id,
      })),
    });
    if (p.isCancel(choice)) return null;
    provider = choice as ProviderId;
  }

  const models = transcriptionModels(provider);
  const modelChoice = await p.select({
    message: "Transcription model",
    options: models.map((model) => ({
      value: model.id,
      label: model.label,
      hint: model.hint,
    })),
  });
  if (p.isCancel(modelChoice)) return null;

  const apiKey = resolveApiKey(config, provider);
  if (!apiKey) return null;

  return { provider, model: modelChoice as string, apiKey };
}
