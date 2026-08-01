import { spawn } from "child_process";

const LOOKUP_TIMEOUT_MS = 10_000;

interface LookupResult {
  code: number | null;
  stdout: string;
}

function lookup(binary: string): Promise<LookupResult> {
  const finder = process.platform === "win32" ? "where" : "which";

  return new Promise((resolve, reject) => {
    const child = spawn(finder, [binary], { env: process.env });

    let stdout = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`${finder} ${binary} timed out.`));
    }, LOOKUP_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ code, stdout });
    });
  });
}

/**
 * Resolves an executable on PATH to its absolute path, or null when it is not
 * installed. Deliberately stops at "the binary exists" instead of running it:
 * a version probe on a cold Python process can take over ten seconds, which is
 * far too long to spend before showing the first prompt.
 */
export async function resolveOnPath(binary: string): Promise<string | null> {
  try {
    const result = await lookup(binary);
    if (result.code !== 0) return null;

    return (
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // The Microsoft Store stub under WindowsApps is not a real interpreter:
        // running it opens the Store and never returns.
        .find((line) => !/[\\/]WindowsApps[\\/]/i.test(line)) ?? null
    );
  } catch {
    return null;
  }
}
