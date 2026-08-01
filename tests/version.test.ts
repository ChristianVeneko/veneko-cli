import { describe, expect, it } from "vitest";
import { compareVersions, REPO_URL, VERSION } from "../src/utils/version.js";

describe("compareVersions", () => {
  it("reports equal versions as equal", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("ignores a leading v on either side", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  it("compares major, minor and patch in order", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it("does not compare version parts as text, so 10 beats 9", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.20.0")).toBeGreaterThan(0);
  });

  it("treats a missing part as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
  });

  it("orders a pre-release before the matching release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("orders pre-releases of the same version against each other", () => {
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  it("does not treat a non-numeric version as newer than everything", () => {
    // A malformed tag parses to 0.0.0 rather than NaN, which would make every
    // comparison false and silently skip the update.
    expect(compareVersions("not-a-version", "0.1.0")).toBeLessThan(0);
  });
});

describe("build metadata", () => {
  it("exposes a version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("points at the repository the installer downloads from", () => {
    expect(REPO_URL).toBe("https://github.com/ChristianVeneko/veneko-cli");
  });
});
