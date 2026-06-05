import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { fileExists } from "./fs.js";
import type { PackageManager } from "../types/index.js";

const execFileAsync = promisify(execFile);

export async function detectPackageManager(dir: string): Promise<PackageManager> {
  const hasBunLock = await fileExists(join(dir, "bun.lock"));
  if (hasBunLock) return "bun";

  const hasPnpmLock = await fileExists(join(dir, "pnpm-lock.yaml"));
  if (hasPnpmLock) return "pnpm";

  return "bun";
}

export async function install(pm: PackageManager, cwd: string): Promise<void> {
  const command = pm === "bun" ? "bun" : "pnpm";
  await execFileAsync(command, ["install"], { cwd, shell: true });
}

export function getRunCommand(pm: PackageManager): string {
  return pm === "bun" ? "bun" : "pnpm";
}
