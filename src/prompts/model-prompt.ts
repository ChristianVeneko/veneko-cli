import * as p from "@clack/prompts";
import pc from "picocolors";
import { c } from "../utils/logger.js";
import { PROVIDERS, getModelLabel, type ProviderId } from "../config/providers.js";
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
