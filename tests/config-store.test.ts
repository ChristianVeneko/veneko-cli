import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  configuredProviders,
  getConfigPath,
  loadConfig,
  maskKey,
  removeCredential,
  resolveApiKey,
  saveConfig,
  setCredential,
  setDefaultModel,
} from "../src/config/store.js";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "veneko-config-"));
  process.env.VENEKO_CONFIG_DIR = configDir;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.XAI_API_KEY;
});

afterEach(async () => {
  delete process.env.VENEKO_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns an empty config when the file does not exist", async () => {
    const config = await loadConfig();
    expect(config.credentials).toEqual({});
    expect(config.defaultModel).toBeUndefined();
  });

  it("ignores unknown providers and non-string keys", async () => {
    await writeFile(
      getConfigPath(),
      JSON.stringify({
        version: 1,
        credentials: { openai: "sk-real", notAProvider: "x", google: 42 },
      }),
      "utf-8"
    );

    const config = await loadConfig();
    expect(config.credentials).toEqual({ openai: "sk-real" });
  });

  it("drops a default model that names an unknown provider", async () => {
    await writeFile(
      getConfigPath(),
      JSON.stringify({ version: 1, credentials: {}, defaultModel: { provider: "nope", model: "m" } }),
      "utf-8"
    );

    const config = await loadConfig();
    expect(config.defaultModel).toBeUndefined();
  });

  it("survives a corrupted config file", async () => {
    await writeFile(getConfigPath(), "{ not json", "utf-8");
    const config = await loadConfig();
    expect(config.credentials).toEqual({});
  });
});

describe("setCredential", () => {
  it("persists the key and reads it back", async () => {
    await setCredential("openai", "sk-test-123");
    const config = await loadConfig();
    expect(config.credentials.openai).toBe("sk-test-123");
  });

  it("trims surrounding whitespace from pasted keys", async () => {
    await setCredential("anthropic", "  sk-ant-padded  ");
    const config = await loadConfig();
    expect(config.credentials.anthropic).toBe("sk-ant-padded");
  });

  it("does not write the key into the file as readable plain-text alongside other providers", async () => {
    await setCredential("openai", "sk-a");
    await setCredential("google", "gk-b");
    const raw = JSON.parse(await readFile(getConfigPath(), "utf-8"));
    expect(raw.credentials).toEqual({ openai: "sk-a", google: "gk-b" });
  });
});

describe("removeCredential", () => {
  it("removes the key", async () => {
    await setCredential("xai", "xai-1");
    await removeCredential("xai");
    const config = await loadConfig();
    expect(config.credentials.xai).toBeUndefined();
  });

  it("clears the default model when its provider loses its key", async () => {
    await setCredential("openai", "sk-a");
    await setDefaultModel("openai", "gpt-4o");
    await removeCredential("openai");

    const config = await loadConfig();
    expect(config.defaultModel).toBeUndefined();
  });

  it("keeps a default model that belongs to a different provider", async () => {
    await setCredential("openai", "sk-a");
    await setCredential("google", "gk-b");
    await setDefaultModel("google", "gemini-2.5-flash");
    await removeCredential("openai");

    const config = await loadConfig();
    expect(config.defaultModel).toEqual({ provider: "google", model: "gemini-2.5-flash" });
  });
});

describe("resolveApiKey", () => {
  it("prefers the stored credential over the environment variable", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    await setCredential("openai", "sk-from-config");

    const config = await loadConfig();
    expect(resolveApiKey(config, "openai")).toBe("sk-from-config");
  });

  it("falls back to the provider environment variable", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const config = await loadConfig();
    expect(resolveApiKey(config, "anthropic")).toBe("sk-ant-env");
  });

  it("returns undefined when neither source has a key", async () => {
    const config = await loadConfig();
    expect(resolveApiKey(config, "xai")).toBeUndefined();
  });
});

describe("configuredProviders", () => {
  it("lists providers backed by either a stored key or an env var", async () => {
    process.env.GEMINI_API_KEY = "gk-env";
    await setCredential("openai", "sk-a");

    const config = await loadConfig();
    expect(configuredProviders(config).sort()).toEqual(["google", "openai"]);
  });

  it("is empty on a fresh install", async () => {
    const config = await loadConfig();
    expect(configuredProviders(config)).toEqual([]);
  });
});

describe("maskKey", () => {
  it("keeps only a prefix and suffix of a long key", () => {
    expect(maskKey("sk-proj-ABCDEFGHIJKLMNOPqrstUvWX")).toBe("sk-pr…UvWX");
  });

  it("fully hides short keys", () => {
    expect(maskKey("short")).toBe("*****");
  });
});

describe("saveConfig", () => {
  it("creates the config directory when it is missing", async () => {
    process.env.VENEKO_CONFIG_DIR = join(configDir, "nested", "deeper");
    await saveConfig({ version: 1, credentials: { openai: "sk-x" } });

    const raw = JSON.parse(await readFile(getConfigPath(), "utf-8"));
    expect(raw.credentials.openai).toBe("sk-x");
  });
});
