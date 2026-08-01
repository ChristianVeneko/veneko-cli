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

/** Extensions Windows considers executable, e.g. `.exe`, `.cmd`, `.bat`. */
const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
  .split(";")
  .map((ext) => ext.trim().toLowerCase())
  .filter((ext) => ext.length > 0);

/**
 * True when Node can actually launch this path.
 *
 * `where npm` lists `C:\Program Files\nodejs\npm` before `npm.cmd`, and that
 * first one is a shell script with no extension — CreateProcess cannot run it,
 * so picking it turns an installed tool into a phantom "not found".
 */
function isLaunchable(candidate: string): boolean {
  if (process.platform !== "win32") return true;
  const lower = candidate.toLowerCase();
  return WINDOWS_EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True for the batch wrappers that Node refuses to spawn without a shell. */
export function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
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

    const candidates = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // The Microsoft Store stub under WindowsApps is not a real interpreter:
      // running it opens the Store and never returns.
      .filter((line) => !/[\\/]WindowsApps[\\/]/i.test(line));

    return candidates.find(isLaunchable) ?? candidates[0] ?? null;
  } catch {
    return null;
  }
}

const VERSION_TIMEOUT_MS = 15_000;

/**
 * Runs a binary's version flag and returns the first line it prints, or null
 * when the binary is missing or does not answer. Only used by diagnostics —
 * the hot paths deliberately stop at "the binary exists".
 */
export async function probeVersion(
  binary: string,
  args: string[] = ["--version"]
): Promise<string | null> {
  const resolved = await resolveOnPath(binary);
  if (!resolved) return null;

  return new Promise((resolve) => {
    // A .cmd wrapper (npm, pnpm) can only be launched through a shell since
    // Node 20.12 hardened spawn, and a shell needs the path quoted because
    // "C:\Program Files\..." is the normal case, not the exception.
    const viaShell = needsShell(resolved);
    const child = spawn(viaShell ? `"${resolved}"` : resolved, args, {
      shell: viaShell,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    let output = "";
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, VERSION_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    // Some tools, notably older Python builds, print the version on stderr.
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const firstLine = output.trim().split(/\r?\n/)[0]?.trim() ?? "";
      finish(code === 0 && firstLine.length > 0 ? firstLine : null);
    });
  });
}
