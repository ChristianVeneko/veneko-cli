import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInstallRoot, readInstallRecord } from "../src/utils/version.js";

/**
 * The installer writes install.json so `veneko update` upgrades in place. When
 * reading it fails the failure is silent — the upgrade just quietly rebuilds
 * into the default location — so every shape it can arrive in is pinned here.
 */

let prefix: string;

beforeEach(async () => {
  prefix = await mkdtemp(join(tmpdir(), "veneko-record-"));
});

afterEach(async () => {
  await rm(prefix, { recursive: true, force: true });
});

async function writeRecord(contents: string): Promise<void> {
  await writeFile(join(prefix, "install.json"), contents, "utf-8");
}

describe("readInstallRecord", () => {
  it("reads the prefix and launcher directory the installer recorded", async () => {
    await writeRecord(JSON.stringify({ prefix, binDir: join(prefix, "bin"), tag: "v1.2.3" }));

    expect(await readInstallRecord(prefix)).toEqual({
      prefix,
      binDir: join(prefix, "bin"),
      tag: "v1.2.3",
    });
  });

  it("reads a file written with a byte order mark", async () => {
    // Windows PowerShell's Set-Content -Encoding UTF8 emits one, and a bare
    // JSON.parse throws on it — silently discarding the record on the very
    // platform that wrote it.
    await writeRecord("\uFEFF" + JSON.stringify({ prefix, binDir: join(prefix, "bin") }));

    expect((await readInstallRecord(prefix))?.prefix).toBe(prefix);
  });

  it("keeps the tag optional", async () => {
    await writeRecord(JSON.stringify({ prefix, binDir: join(prefix, "bin") }));

    expect((await readInstallRecord(prefix))?.tag).toBeUndefined();
  });

  it("returns null when there is no record, as in a source checkout", async () => {
    expect(await readInstallRecord(prefix)).toBeNull();
  });

  it("returns null for a truncated or corrupt file rather than throwing", async () => {
    await writeRecord('{"prefix": "C:\\\\somewhere",');

    expect(await readInstallRecord(prefix)).toBeNull();
  });

  it("rejects a record missing the fields the upgrade needs", async () => {
    await writeRecord(JSON.stringify({ tag: "v1.0.0" }));

    expect(await readInstallRecord(prefix)).toBeNull();
  });

  it("defaults to the directory above this bundle when none is given", async () => {
    // No record exists there during a test run, so null is the right answer —
    // what matters is that it resolves a path instead of throwing.
    expect(await readInstallRecord()).toBeNull();
  });
});

describe("getInstallRoot", () => {
  it("returns an absolute directory", async () => {
    const { isAbsolute } = await import("path");
    expect(isAbsolute(getInstallRoot())).toBe(true);
  });
});
