import * as p from "@clack/prompts";
import pc from "picocolors";
import { c } from "../utils/logger.js";
import { PROVIDERS, getModelLabel, type ProviderId } from "../config/providers.js";
import {
  configuredProviders,
  getConfigPath,
  loadConfig,
  maskKey,
  removeCredential,
  resolveApiKey,
  setCredential,
  setDefaultModel,
  type VenekoConfig,
} from "../config/store.js";

const CUSTOM_MODEL = "__custom__";
const BACK = "__back__";

function isBack(value: unknown): boolean {
  return p.isCancel(value) || value === BACK;
}

function credentialStatus(config: VenekoConfig, provider: ProviderId): string {
  const stored = config.credentials[provider];
  if (stored) return c.success(maskKey(stored));

  const envKey = resolveApiKey(config, provider);
  if (envKey) {
    const envVar = PROVIDERS.find((item) => item.id === provider)?.envVar ?? "env";
    return c.warn(`from ${envVar}`);
  }

  return pc.dim("not set");
}

async function promptCredentialForProvider(provider: ProviderId): Promise<void> {
  const info = PROVIDERS.find((item) => item.id === provider);
  if (!info) return;

  const config = await loadConfig();
  const stored = config.credentials[provider];

  if (stored) {
    const action = await p.select({
      message: `${info.label} — ${maskKey(stored)}`,
      options: [
        { value: "replace", label: "Replace key" },
        { value: "remove", label: "Remove key" },
        { value: BACK, label: "Back" },
      ],
    });

    if (isBack(action)) return;

    if (action === "remove") {
      await removeCredential(provider);
      p.log.success(`${c.success("✔")} Removed the ${info.label} API key.`);
      return;
    }
  }

  const apiKey = await p.password({
    message: `${info.label} API key`,
    validate: (value) => {
      if (!value || value.trim().length === 0) return "API key is required.";
      if (/\s/.test(value.trim())) return "API key cannot contain whitespace.";
      return undefined;
    },
  });

  if (p.isCancel(apiKey)) return;

  await setCredential(provider, apiKey);
  p.log.success(
    `${c.success("✔")} Saved ${c.highlight(info.label)} key ${pc.dim(`(${maskKey(apiKey.trim())})`)}`
  );
  p.log.info(`${pc.dim("Get keys at")} ${pc.dim(info.keysUrl)}`);
}

async function runCredentialsMenu(): Promise<void> {
  for (;;) {
    const config = await loadConfig();

    const choice = await p.select({
      message: "Credentials — select a provider to configure",
      options: [
        ...PROVIDERS.map((provider) => ({
          value: provider.id as string,
          label: provider.label,
          hint: credentialStatus(config, provider.id),
        })),
        { value: BACK, label: "Back", hint: "return to configuration" },
      ],
    });

    if (isBack(choice)) return;

    await promptCredentialForProvider(choice as ProviderId);
  }
}

async function runDefaultModelMenu(): Promise<void> {
  const config = await loadConfig();
  const available = configuredProviders(config);

  if (available.length === 0) {
    p.log.warn(
      `${c.warn("⚠")} No API keys configured yet.\n` +
      pc.dim("  Add one under Configuration > Credentials first.")
    );
    return;
  }

  const providerChoice = await p.select({
    message: "Default provider for AI tools",
    options: [
      ...available.map((id) => {
        const info = PROVIDERS.find((item) => item.id === id);
        return {
          value: id as string,
          label: info?.label ?? id,
          hint: config.defaultModel?.provider === id ? "current" : undefined,
        };
      }),
      { value: BACK, label: "Back" },
    ],
  });

  if (isBack(providerChoice)) return;

  const provider = providerChoice as ProviderId;
  const info = PROVIDERS.find((item) => item.id === provider);
  const current = config.defaultModel;

  const modelChoice = await p.select({
    message: `Default model for ${info?.label ?? provider}`,
    options: [
      ...(info?.models ?? []).map((model) => ({
        value: model.id,
        label: model.label,
        hint:
          current?.provider === provider && current.model === model.id
            ? "current"
            : model.vision
              ? "vision"
              : undefined,
      })),
      { value: CUSTOM_MODEL, label: "Other…", hint: "type a model id manually" },
      { value: BACK, label: "Back" },
    ],
  });

  if (isBack(modelChoice)) return;

  let model = modelChoice as string;

  if (model === CUSTOM_MODEL) {
    const typed = await p.text({
      message: "Model id",
      placeholder: info?.models[0]?.id,
      validate: (value) =>
        value && value.trim().length > 0 ? undefined : "Model id is required.",
    });
    if (p.isCancel(typed)) return;
    model = typed.trim();
  }

  await setDefaultModel(provider, model);
  p.log.success(
    `${c.success("✔")} Default model set to ${c.highlight(getModelLabel(provider, model))} ` +
    pc.dim(`(${info?.label ?? provider})`)
  );
}

async function showCurrentConfig(): Promise<void> {
  const config = await loadConfig();
  const configured = configuredProviders(config);

  const lines = [
    `${pc.bold("Config file")}   ${pc.dim(getConfigPath())}`,
    "",
    pc.bold("Credentials:"),
    ...PROVIDERS.map(
      (provider) =>
        `  ${pc.dim("▸")} ${provider.label.padEnd(20)} ${credentialStatus(config, provider.id)}`
    ),
    "",
    pc.bold("Default model:"),
    config.defaultModel
      ? `  ${pc.dim("▸")} ${c.highlight(getModelLabel(config.defaultModel.provider, config.defaultModel.model))} ` +
        pc.dim(`(${config.defaultModel.provider})`)
      : `  ${pc.dim("▸")} ${pc.dim("not set")}`,
  ];

  if (configured.length === 0) {
    lines.push("", pc.dim("Add a key under Credentials to enable AI tools."));
  }

  p.note(lines.join("\n"), pc.bold("▸ Current configuration"));
}

export async function runConfigMenu(): Promise<void> {
  for (;;) {
    const choice = await p.select({
      message: "Configuration",
      options: [
        { value: "credentials", label: "Credentials", hint: "AI provider API keys" },
        { value: "default-model", label: "Default AI model", hint: "used by tools" },
        { value: "show", label: "Show current configuration" },
        { value: BACK, label: "Back", hint: "return to main menu" },
      ],
    });

    if (isBack(choice)) return;

    switch (choice) {
      case "credentials":
        await runCredentialsMenu();
        break;
      case "default-model":
        await runDefaultModelMenu();
        break;
      case "show":
        await showCurrentConfig();
        break;
    }
  }
}
