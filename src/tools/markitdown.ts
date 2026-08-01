import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * markitdown is a Python package, not a Node one. veneko shells out to whatever
 * entry point the machine has instead of shipping a port of it.
 */
export interface MarkitdownCommand {
  /** Absolute path to the executable, so no shell resolution is needed. */
  command: string;
  /** Leading arguments, before the ones for the conversion itself. */
  baseArgs: string[];
  /** Human-readable form, for diagnostics. */
  label: string;
}

interface Candidate {
  /** Executable to look for on PATH. */
  binary: string;
  baseArgs: string[];
}

/** Tried in order; the first one present on PATH wins. */
const CANDIDATES: Candidate[] = [
  { binary: "markitdown", baseArgs: [] },
  { binary: "python", baseArgs: ["-m", "markitdown"] },
  { binary: "python3", baseArgs: ["-m", "markitdown"] },
  // The Windows Python launcher, for installs that are not on PATH as `python`.
  { binary: "py", baseArgs: ["-m", "markitdown"] },
];

export const MARKITDOWN_INSTALL_HINT =
  "markitdown was not found. It is a Python package:\n" +
  "  pip install 'markitdown[all]'\n" +
  "Requires Python 3.10+. See https://github.com/microsoft/markitdown";

/**
 * Extensions markitdown converts out of the box. Used only to warn early — the
 * conversion is still attempted for anything else, since markitdown sniffs the
 * real type and handles more formats than this list.
 */
export const MARKITDOWN_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".xls",
  ".epub",
  ".msg",
  ".html",
  ".htm",
  ".csv",
  ".json",
  ".jsonl",
  ".xml",
  ".txt",
  ".md",
  ".markdown",
  ".ipynb",
  ".zip",
  ".jpg",
  ".jpeg",
  ".png",
  ".wav",
  ".mp3",
  ".m4a",
  ".mp4",
];

const LOOKUP_TIMEOUT_MS = 10_000;
/**
 * Generous on purpose: importing markitdown alone takes over ten seconds on a
 * cold Python process, before any conversion work starts.
 */
const DEFAULT_CONVERT_TIMEOUT_MS = 300_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // Python pipes stdout using the locale encoding, which mangles non-ASCII
      // text on Windows. This keeps its diagnostics readable.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Resolves an executable on PATH, or null when it is not there.
 *
 * Detection deliberately stops at "the binary exists" rather than running
 * `markitdown --version`: a cold Python import of markitdown takes over ten
 * seconds, which is far too long to spend before the first prompt. A wrong
 * guess costs a clear error at conversion time, not a stalled menu.
 */
async function resolveOnPath(binary: string): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";

  try {
    const result = await run(finder, [binary], LOOKUP_TIMEOUT_MS);
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

let cached: MarkitdownCommand | null | undefined;

/**
 * Finds a usable markitdown entry point, or null when none is installed.
 * The result is cached for the process — installs do not appear mid-session.
 */
export async function detectMarkitdown(): Promise<MarkitdownCommand | null> {
  if (cached !== undefined) return cached;

  for (const candidate of CANDIDATES) {
    const resolved = await resolveOnPath(candidate.binary);
    if (resolved) {
      cached = {
        command: resolved,
        baseArgs: candidate.baseArgs,
        label: [candidate.binary, ...candidate.baseArgs].join(" "),
      };
      return cached;
    }
  }

  cached = null;
  return null;
}

/** Exposed for tests; production code has no reason to call this. */
export function resetMarkitdownCache(): void {
  cached = undefined;
}

function describeFailure(stderr: string): string {
  const detail = stderr.trim().split("\n").slice(-8).join("\n");

  // Python was on PATH but markitdown was not installed into it.
  if (/No module named ['"]?markitdown/i.test(stderr)) {
    return MARKITDOWN_INSTALL_HINT;
  }
  if (/MissingDependencyException|missing.*dependenc/i.test(stderr)) {
    return (
      "markitdown is missing an optional dependency for this file type.\n" +
      "Install the full set with: pip install 'markitdown[all]'\n" +
      detail
    );
  }
  if (/UnsupportedFormatException|could not convert/i.test(stderr)) {
    return `markitdown cannot convert this file.\n${detail}`;
  }

  return `markitdown failed.\n${detail}`;
}

export interface ExtractOptions {
  /** Reuses an already-detected entry point instead of probing again. */
  command?: MarkitdownCommand;
  timeoutMs?: number;
}

/**
 * Converts any document markitdown supports into raw Markdown.
 *
 * Output goes through `-o <file>` rather than stdout: markitdown writes that
 * file as UTF-8, while its stdout path replaces characters it cannot encode in
 * the console codepage — which silently corrupts accented text on Windows.
 */
export async function extractMarkdown(
  filePath: string,
  options: ExtractOptions = {}
): Promise<string> {
  const command = options.command ?? (await detectMarkitdown());
  if (!command) {
    throw new Error(MARKITDOWN_INSTALL_HINT);
  }

  const workDir = await mkdtemp(join(tmpdir(), "veneko-markitdown-"));
  const outFile = join(workDir, "out.md");

  try {
    const result = await run(
      command.command,
      [...command.baseArgs, filePath, "-o", outFile],
      options.timeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS
    );

    if (result.code !== 0) {
      throw new Error(describeFailure(result.stderr || result.stdout));
    }

    // markitdown emits CRLF on Windows. Normalizing here keeps every consumer
    // — chunking, prompts, the written file — on a single line ending.
    const markdown = (await readFile(outFile, "utf-8")).replace(/\r\n/g, "\n").trim();
    if (markdown.length === 0) {
      throw new Error(
        "markitdown produced an empty document. If this is a scanned PDF, use the " +
        "Scanned PDF to Markdown tool instead — it reads pages as images."
      );
    }

    return markdown;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
