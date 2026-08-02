import type { Command } from "commander";
import { arch, release } from "os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { probeVersion, resolveOnPath } from "../utils/binaries.js";
import { installHint, platformLabel } from "../utils/platform-hints.js";
import { compareVersions, getInstallRoot, REPO_URL, VERSION } from "../utils/version.js";
import { fetchLatestRelease } from "../utils/github.js";
import { configuredProviders, getConfigPath, loadConfig } from "../config/store.js";
import { fileExists } from "../utils/fs.js";
import { c, printBanner } from "../utils/logger.js";
import type { CommandRunOptions } from "../types/index.js";

/**
 * Oldest Node that this build targets. pdfjs-dist needs an ArrayBuffer method
 * that only exists from Node 21 on, and Node 20 is end of life regardless.
 */
const MIN_NODE_MAJOR = 22;
/** markitdown needs 3.10; yt-dlp needs 3.9. The stricter one wins. */
const MIN_PYTHON = [3, 10] as const;

type Status = "ok" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail: string;
  hint?: string;
}

interface Section {
  title: string;
  checks: Check[];
}

function symbol(status: Status): string {
  if (status === "ok") return c.success("✔");
  if (status === "warn") return c.warn("○");
  return c.error("✖");
}

/** Pulls `3.12.4` out of strings like `Python 3.12.4` or `v20.11.0`. */
function extractVersion(raw: string | null): number[] | null {
  if (!raw) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split(".")[0]);

  if (major < MIN_NODE_MAJOR) {
    return {
      label: "Node.js",
      status: "fail",
      detail: `v${process.versions.node} — veneko needs ${MIN_NODE_MAJOR} or newer`,
      hint: installHint("node"),
    };
  }

  return { label: "Node.js", status: "ok", detail: `v${process.versions.node}` };
}

async function checkBinary(
  label: string,
  binary: string,
  options: { required?: boolean; hint?: string; args?: string[] } = {}
): Promise<Check> {
  const version = await probeVersion(binary, options.args);
  if (version) {
    return { label, status: "ok", detail: version };
  }

  // The binary can exist yet fail to answer — a broken install, not a missing
  // one, and the fix is different.
  const present = (await resolveOnPath(binary)) !== null;
  return {
    label,
    status: options.required ? "fail" : "warn",
    detail: present ? "found on PATH but it does not run" : "not installed",
    hint: options.hint,
  };
}

async function checkPython(): Promise<{ python: Check; interpreter: string | null }> {
  // macOS and most distros ship `python3`; Windows installs answer to `py`.
  for (const binary of ["python3", "python", "py"]) {
    const raw = await probeVersion(binary);
    const parsed = extractVersion(raw);
    if (!parsed) continue;

    const [major, minor] = parsed;
    const tooOld = major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1]);

    return {
      python: {
        label: "Python",
        status: tooOld ? "warn" : "ok",
        detail: tooOld
          ? `${raw} — the document tools need ${MIN_PYTHON[0]}.${MIN_PYTHON[1]} or newer`
          : `${raw} (${binary})`,
        hint: tooOld ? installHint("python") : undefined,
      },
      interpreter: binary,
    };
  }

  return {
    python: {
      label: "Python",
      status: "warn",
      detail: "not installed — the document and download tools need it",
      hint: installHint("python"),
    },
    interpreter: null,
  };
}

/**
 * Probes a Python-backed tool through its own binary first, then through the
 * interpreter. `python -m markitdown --version` is the only honest test: the
 * plain PATH lookup would find Python and report a module that is not there.
 */
async function checkPythonTool(
  label: string,
  binary: string,
  moduleName: string,
  interpreter: string | null
): Promise<Check> {
  const direct = await probeVersion(binary);
  if (direct) return { label, status: "ok", detail: direct };

  if (interpreter) {
    const viaModule = await probeVersion(interpreter, ["-m", moduleName, "--version"]);
    if (viaModule) return { label, status: "ok", detail: `${viaModule} (${interpreter} -m ${moduleName})` };
  }

  return {
    label,
    status: "warn",
    detail: "not installed",
    hint: installHint(binary === "yt-dlp" ? "yt-dlp" : "markitdown"),
  };
}

async function configurationChecks(): Promise<Check[]> {
  const config = await loadConfig();
  const configPath = getConfigPath();
  const providers = configuredProviders(config);

  return [
    {
      label: "Config file",
      status: (await fileExists(configPath)) ? "ok" : "warn",
      detail: (await fileExists(configPath)) ? configPath : `not created yet — ${configPath}`,
      hint: (await fileExists(configPath)) ? undefined : "Run `veneko config` to add an API key.",
    },
    {
      label: "AI providers",
      status: providers.length > 0 ? "ok" : "warn",
      detail: providers.length > 0 ? providers.join(", ") : "no API key configured",
      hint: providers.length > 0 ? undefined : "Run `veneko config` to add one.",
    },
    {
      label: "Default model",
      status: config.defaultModel ? "ok" : "warn",
      detail: config.defaultModel
        ? `${config.defaultModel.provider} / ${config.defaultModel.model}`
        : "not set — the AI tools will ask every time",
    },
  ];
}

async function updateCheck(offline: boolean): Promise<Check> {
  if (offline) {
    return { label: "veneko", status: "ok", detail: `${VERSION} (update check skipped)` };
  }

  try {
    const latest = await fetchLatestRelease();
    const behind = compareVersions(VERSION, latest.version) < 0;

    return {
      label: "veneko",
      status: behind ? "warn" : "ok",
      detail: behind ? `${VERSION} — ${latest.tag} is available` : `${VERSION} (up to date)`,
      hint: behind ? "Run `veneko update` to upgrade." : undefined,
    };
  } catch (err) {
    return {
      label: "veneko",
      status: "warn",
      detail: `${VERSION} — ${err instanceof Error ? err.message : "update check failed"}`,
    };
  }
}

function render(sections: Section[]): void {
  const width = Math.max(
    ...sections.flatMap((section) => section.checks.map((check) => check.label.length))
  );

  for (const section of sections) {
    process.stdout.write(`\n${pc.bold(section.title)}\n`);
    for (const check of section.checks) {
      const label = check.label.padEnd(width);
      process.stdout.write(`  ${symbol(check.status)} ${label}  ${check.detail}\n`);
      if (check.hint) {
        process.stdout.write(`  ${" ".repeat(width + 3)}${c.dim(`→ ${check.hint}`)}\n`);
      }
    }
  }
}

export interface DoctorOptions extends CommandRunOptions {
  /** Skips the GitHub release lookup. */
  offline?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  if (!options.fromMenu) {
    printBanner("check that everything veneko needs is in place");
  }

  const s = p.spinner();
  s.start("Inspecting this machine...");

  const { python, interpreter } = await checkPython();

  const sections: Section[] = [
    {
      title: "Runtime",
      checks: [
        await checkNode(),
        await checkBinary("git", "git", { hint: installHint("git") }),
        {
          label: "Platform",
          status: "ok",
          detail: `${platformLabel()} ${release()} (${arch()})`,
        },
        { label: "Install root", status: "ok", detail: getInstallRoot() },
      ],
    },
    {
      title: "Package managers",
      checks: [
        await checkBinary("bun", "bun"),
        await checkBinary("pnpm", "pnpm"),
        await checkBinary("npm", "npm", { required: true, hint: installHint("node") }),
      ],
    },
    {
      title: "Tools",
      checks: [
        python,
        await checkPythonTool("markitdown", "markitdown", "markitdown", interpreter),
        await checkPythonTool("yt-dlp", "yt-dlp", "yt_dlp", interpreter),
        // ffmpeg only understands the single-dash form.
        await checkBinary("ffmpeg", "ffmpeg", { hint: installHint("ffmpeg"), args: ["-version"] }),
      ],
    },
    { title: "Configuration", checks: await configurationChecks() },
    { title: "Updates", checks: [await updateCheck(options.offline === true)] },
  ];

  s.stop("Diagnosis complete.");
  render(sections);

  const failures = sections.flatMap((s2) => s2.checks).filter((check) => check.status === "fail");
  const warnings = sections.flatMap((s2) => s2.checks).filter((check) => check.status === "warn");

  process.stdout.write("\n");
  if (failures.length > 0) {
    process.stdout.write(
      `${c.error("✖")} ${failures.length} blocking problem(s). veneko will not work correctly until they are fixed.\n`
    );
  } else if (warnings.length > 0) {
    process.stdout.write(
      `${c.warn("○")} Everything essential is in place. ${warnings.length} optional item(s) are missing — the tools that need them will say so.\n`
    );
  } else {
    process.stdout.write(`${c.success("✔")} Everything is in place.\n`);
  }
  process.stdout.write(c.dim(`  ${REPO_URL}\n\n`));

  // A broken runtime should fail the command, so scripts and CI can rely on it.
  if (failures.length > 0 && !options.fromMenu) process.exitCode = 1;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check Node, Python, tools and configuration on this machine")
    .option("--offline", "skip the check for a newer release")
    .action(async (opts: { offline?: boolean }) => {
      await runDoctor({ offline: opts.offline });
    });
}
