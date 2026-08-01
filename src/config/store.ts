import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { isProviderId, PROVIDERS, type ProviderId } from "./providers.js";

export interface DefaultModel {
  provider: ProviderId;
  model: string;
}

export interface VenekoConfig {
  version: number;
  /** API keys keyed by provider. Stored in plain text, so the file is 0600. */
  credentials: Partial<Record<ProviderId, string>>;
  /** Model that tools use when the user does not pick one explicitly. */
  defaultModel?: DefaultModel;
}

const CONFIG_VERSION = 1;

const EMPTY_CONFIG: VenekoConfig = {
  version: CONFIG_VERSION,
  credentials: {},
};

export function getConfigDir(): string {
  return process.env.VENEKO_CONFIG_DIR ?? join(homedir(), ".veneko");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function normalize(raw: unknown): VenekoConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...EMPTY_CONFIG, credentials: {} };
  }

  const parsed = raw as Partial<VenekoConfig>;
  const credentials: Partial<Record<ProviderId, string>> = {};

  for (const [key, value] of Object.entries(parsed.credentials ?? {})) {
    if (isProviderId(key) && typeof value === "string" && value.length > 0) {
      credentials[key] = value;
    }
  }

  let defaultModel: DefaultModel | undefined;
  const rawDefault = parsed.defaultModel;
  if (
    rawDefault &&
    isProviderId(rawDefault.provider) &&
    typeof rawDefault.model === "string" &&
    rawDefault.model.length > 0
  ) {
    defaultModel = { provider: rawDefault.provider, model: rawDefault.model };
  }

  return { version: CONFIG_VERSION, credentials, defaultModel };
}

export async function loadConfig(): Promise<VenekoConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    return normalize(JSON.parse(raw));
  } catch {
    // Missing or unreadable config — start fresh rather than failing the CLI.
    return { ...EMPTY_CONFIG, credentials: {} };
  }
}

export async function saveConfig(config: VenekoConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });

  try {
    // writeFile only applies mode when creating the file, so enforce it on rewrites.
    await chmod(configPath, 0o600);
  } catch {
    // chmod is a no-op on some Windows setups — the file is still user-scoped.
  }
}

export async function setCredential(provider: ProviderId, apiKey: string): Promise<VenekoConfig> {
  const config = await loadConfig();
  config.credentials[provider] = apiKey.trim();
  await saveConfig(config);
  return config;
}

export async function removeCredential(provider: ProviderId): Promise<VenekoConfig> {
  const config = await loadConfig();
  delete config.credentials[provider];

  // A default model pointing at a provider with no key would fail at call time.
  if (config.defaultModel?.provider === provider) {
    delete config.defaultModel;
  }

  await saveConfig(config);
  return config;
}

export async function setDefaultModel(
  provider: ProviderId,
  model: string
): Promise<VenekoConfig> {
  const config = await loadConfig();
  config.defaultModel = { provider, model: model.trim() };
  await saveConfig(config);
  return config;
}

/**
 * Resolves the key for a provider: the stored credential wins, then the
 * provider's environment variable.
 */
export function resolveApiKey(
  config: VenekoConfig,
  provider: ProviderId
): string | undefined {
  const stored = config.credentials[provider];
  if (stored) return stored;

  const envVar = PROVIDERS.find((p) => p.id === provider)?.envVar;
  const fromEnv = envVar ? process.env[envVar] : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function configuredProviders(config: VenekoConfig): ProviderId[] {
  return PROVIDERS.filter((p) => resolveApiKey(config, p.id) !== undefined).map((p) => p.id);
}

/** Renders a key as `sk-pr…UvWX` so it can be shown without leaking it. */
export function maskKey(apiKey: string): string {
  if (apiKey.length <= 10) return "*".repeat(apiKey.length);
  return `${apiKey.slice(0, 5)}…${apiKey.slice(-4)}`;
}
