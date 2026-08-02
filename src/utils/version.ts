import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Version of this build, injected by tsup from package.json. The guard keeps
 * the CLI usable when the source is run directly (ts-node, vitest, a bundler
 * that does not perform the substitution).
 */
export const VERSION: string =
  typeof __VENEKO_VERSION__ === "string" ? __VENEKO_VERSION__ : "0.0.0-dev";

export const REPO_OWNER = "ChristianVeneko";
export const REPO_NAME = "veneko-cli";
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/**
 * Root of the installed copy: the directory that holds dist/, package.json and
 * scripts/. The bundle always lands in `<root>/dist/index.js`, so the root is
 * one level up from wherever this module ended up.
 */
export function getInstallRoot(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return dirname(distDir);
}

/** Absolute path to the bundled installer for this platform. */
export function getInstallerPath(): string {
  const script = process.platform === "win32" ? "install.ps1" : "install.sh";
  return join(getInstallRoot(), "scripts", script);
}

/** Where the installer put things, as it recorded at install time. */
export interface InstallRecord {
  prefix: string;
  binDir: string;
  tag?: string;
}

/**
 * Reads the record the installer leaves beside the app.
 *
 * Without it an upgrade would re-run the installer with default paths, quietly
 * moving an install that used a custom prefix. Returns null for a source
 * checkout, which has no record and should not be upgraded in place anyway.
 *
 * The directory is a parameter so the failure modes can be tested; production
 * callers let it default to the parent of this bundle.
 */
export async function readInstallRecord(
  prefix: string = dirname(getInstallRoot())
): Promise<InstallRecord | null> {
  try {
    const raw = await readFile(join(prefix, "install.json"), "utf-8");
    // Windows PowerShell writes UTF-8 with a byte order mark, and JSON.parse
    // rejects the leading ﻿ outright — which would silently discard the
    // record on exactly the platform that wrote it.
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as Partial<InstallRecord>;
    if (typeof parsed.prefix !== "string" || typeof parsed.binDir !== "string") return null;

    return { prefix: parsed.prefix, binDir: parsed.binDir, tag: parsed.tag };
  } catch {
    return null;
  }
}

/**
 * Compares two semantic versions, ignoring any leading `v`. Returns a positive
 * number when `a` is newer. Pre-release suffixes are treated as older than the
 * matching release, which is what `1.0.0-rc.1` vs `1.0.0` should mean.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string) => {
    const [core, pre] = raw.replace(/^v/, "").split("-", 2);
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { parts, pre: pre ?? null };
  };

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre > right.pre ? 1 : -1;
}
