import { readdir, stat, mkdir, readFile, writeFile } from "fs/promises";
import { join, relative } from "path";

export async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(relative(dir, fullPath));
      }
    }
  }

  await walk(dir);
  return files;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function mergeJsonFile(
  filePath: string,
  data: Record<string, unknown>
): Promise<void> {
  let existing: Record<string, unknown> = {};

  if (await fileExists(filePath)) {
    const raw = await readFile(filePath, "utf-8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  }

  const merged = deepMerge(existing, data);
  await writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      isPlainObject(sourceVal) &&
      isPlainObject(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
