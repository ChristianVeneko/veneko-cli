import { describe, expect, it } from "vitest";
import { PROVIDERS, getModelLabel, getProvider, isProviderId } from "../src/config/providers.js";

describe("provider registry", () => {
  it("covers the providers the CLI advertises", () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(["anthropic", "google", "openai", "xai"]);
  });

  it("gives every provider a key env var and at least one vision model", () => {
    for (const provider of PROVIDERS) {
      expect(provider.envVar).toMatch(/^[A-Z0-9_]+$/);
      expect(provider.models.some((model) => model.vision)).toBe(true);
    }
  });

  it("uses unique model ids within a provider", () => {
    for (const provider of PROVIDERS) {
      const ids = provider.models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("isProviderId", () => {
  it("accepts known ids and rejects everything else", () => {
    expect(isProviderId("openai")).toBe(true);
    expect(isProviderId("gemini")).toBe(false);
  });
});

describe("getProvider", () => {
  it("throws on an unknown id", () => {
    // @ts-expect-error exercising the runtime guard with an invalid id
    expect(() => getProvider("nope")).toThrow(/Unknown provider/);
  });
});

describe("getModelLabel", () => {
  it("returns the registry label for a known model", () => {
    expect(getModelLabel("openai", "gpt-4o")).toBe("GPT-4o");
  });

  it("falls back to the raw id for a model typed in manually", () => {
    expect(getModelLabel("openai", "gpt-6-experimental")).toBe("gpt-6-experimental");
  });
});
