import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { fileExists } from "./fs.js";
import { resolveOnPath } from "./binaries.js";
import type { PackageManager } from "../types/index.js";

const execFileAsync = promisify(execFile);

/** Ordered by preference when nothing in the project says which one to use. */
const PREFERENCE: PackageManager[] = ["bun", "pnpm", "npm"];

const LOCKFILES: [string, PackageManager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
];

export async function isInstalled(pm: PackageManager): Promise<boolean> {
  return (await resolveOnPath(pm)) !== null;
}

/**
 * The first package manager actually present on this machine. npm is the last
 * resort because it ships with Node: assuming bun exists everywhere is how a
 * fresh macOS or Linux box ends up with a scaffolded project it cannot install.
 */
export async function firstInstalled(): Promise<PackageManager> {
  for (const pm of PREFERENCE) {
    if (await isInstalled(pm)) return pm;
  }
  return "npm";
}

/** Lockfile wins, since it is what the project already committed to. */
export async function detectPackageManager(dir: string): Promise<PackageManager> {
  for (const [lockfile, pm] of LOCKFILES) {
    if (await fileExists(join(dir, lockfile))) return pm;
  }

  return firstInstalled();
}

/**
 * Installs dependencies and returns the manager that actually ran — it can
 * differ from the requested one when that manager is not installed here.
 *
 * `shell: true` is required on Windows, where npm, pnpm and bun are `.cmd`
 * shims that Node refuses to spawn directly.
 */
export async function install(pm: PackageManager, cwd: string): Promise<PackageManager> {
  const effective = (await isInstalled(pm)) ? pm : await firstInstalled();
  await execFileAsync(effective, ["install"], { cwd, shell: true });
  return effective;
}

/** The prefix for running a package script, e.g. `pnpm run dev`. */
export function getRunCommand(pm: PackageManager): string {
  return `${pm} run`;
}
