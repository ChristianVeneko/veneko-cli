import { spawn } from "child_process";
import { dirname } from "path";
import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { fetchLatestRelease, ReleaseLookupError, type LatestRelease } from "../utils/github.js";
import {
  compareVersions,
  getInstallerPath,
  getInstallRoot,
  readInstallRecord,
  REPO_OWNER,
  REPO_NAME,
  REPO_URL,
  VERSION,
  type InstallRecord,
} from "../utils/version.js";
import { resolveOnPath } from "../utils/binaries.js";
import { fileExists } from "../utils/fs.js";
import { c, printBanner } from "../utils/logger.js";
import type { CommandRunOptions } from "../types/index.js";

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/scripts`;

/** The published one-liner, shown whenever the local installer cannot be used. */
export function manualInstallCommand(): string {
  if (process.platform === "win32") {
    return `irm ${RAW_BASE}/install.ps1 | iex`;
  }
  return `curl -fsSL ${RAW_BASE}/install.sh | bash`;
}

interface Runner {
  command: string;
  args: string[];
}

/**
 * Builds the invocation for the bundled installer. Windows needs an explicit
 * host and execution policy because a downloaded .ps1 is blocked by default.
 */
async function installerRunner(scriptPath: string, assumeYes: boolean): Promise<Runner | null> {
  if (process.platform === "win32") {
    const host = (await resolveOnPath("pwsh")) ? "pwsh" : "powershell";
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
    if (assumeYes) args.push("-Yes");
    return { command: host, args };
  }

  if (!(await resolveOnPath("bash"))) return null;

  const args = [scriptPath];
  if (assumeYes) args.push("--yes");
  return { command: "bash", args };
}

function runInstaller(runner: Runner, record: InstallRecord | null): Promise<number> {
  return new Promise((resolve, reject) => {
    // The installer defaults to the standard locations, so an install that
    // lives anywhere else has to be told, or the upgrade lands in the default
    // path and leaves the running copy behind, unupgraded.
    //
    // The prefix is derived from where this bundle actually sits rather than
    // taken from the record, so it is right even for a version installed before
    // the record existed. The record only adds the launcher directory, which
    // nothing else can reveal.
    //
    // The optional tools are left out of an upgrade on purpose: they were
    // decided once, at install time, and re-running that here would install
    // pipx and its packages on a machine whose owner only asked for a newer
    // veneko.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VENEKO_UPDATED_FROM: VERSION,
      VENEKO_HOME: record?.prefix ?? dirname(getInstallRoot()),
      VENEKO_NO_PYTHON: "1",
      VENEKO_NO_FFMPEG: "1",
    };
    if (record) env.VENEKO_BIN_DIR = record.binDir;

    // stdio is inherited on purpose: the installer prints its own progress, and
    // buffering it would leave the user staring at a frozen spinner for minutes.
    const child = spawn(runner.command, runner.args, { stdio: "inherit", env });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function printReleaseNotes(release: LatestRelease): void {
  if (!release.notes) return;

  const lines = release.notes.split("\n").slice(0, 20);
  const truncated = release.notes.split("\n").length > 20;

  p.note(lines.join("\n") + (truncated ? `\n${pc.dim("...")}` : ""), pc.bold(`What's new in ${release.tag}`));
}

export interface UpdateOptions extends CommandRunOptions {
  /** Report the available version and stop. */
  checkOnly?: boolean;
  /** Do not ask for confirmation. */
  yes?: boolean;
  /** Reinstall even when the running version is already the latest. */
  force?: boolean;
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  if (!options.fromMenu) {
    printBanner("update veneko to the latest release");
  }

  p.intro(pc.bold(pc.cyan(" veneko update ")));

  const s = p.spinner();
  s.start("Checking GitHub for a newer release...");

  let release: LatestRelease;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    s.stop(`${c.error("✖")} Update check failed.`);
    const message = err instanceof ReleaseLookupError ? err.message : String(err);
    p.log.error(message);
    p.outro(c.dim(`Releases: ${REPO_URL}/releases`));
    process.exitCode = 1;
    return;
  }

  const comparison = compareVersions(VERSION, release.version);
  s.stop(`${c.success("✔")} Latest release is ${c.highlight(release.tag)}.`);

  if (comparison >= 0 && !options.force) {
    const detail =
      comparison > 0
        ? `You are running ${c.highlight(VERSION)}, which is newer than the latest release — nothing to do.`
        : `You are already on ${c.highlight(VERSION)}.`;
    p.log.success(detail);
    p.outro(c.dim("Use --force to reinstall this version anyway."));
    return;
  }

  if (comparison < 0) {
    p.log.info(`${c.dim("current")} ${VERSION}  ${c.dim("→")}  ${c.highlight(release.version)}`);
    printReleaseNotes(release);
  }

  if (options.checkOnly) {
    p.outro(c.dim("Run `veneko update` to install it."));
    return;
  }

  const installer = getInstallerPath();
  if (!(await fileExists(installer))) {
    // A development checkout or an `npm link` install has no bundled installer.
    p.log.warn(
      `No installer found at ${c.dim(installer)}.\n` +
        "This looks like a source checkout rather than a normal install."
    );
    p.note(manualInstallCommand(), pc.bold("Install the latest release with"));
    p.outro(c.dim(`Install root: ${getInstallRoot()}`));
    return;
  }

  if (!options.yes) {
    const proceed = await p.confirm({
      message: `Install ${release.tag} now?`,
      initialValue: true,
    });

    if (p.isCancel(proceed) || !proceed) {
      p.outro(c.dim("Nothing was changed."));
      return;
    }
  }

  const runner = await installerRunner(installer, true);
  if (!runner) {
    p.log.error("bash was not found on PATH, so the installer cannot run.");
    p.note(manualInstallCommand(), pc.bold("Install manually with"));
    process.exitCode = 1;
    return;
  }

  p.log.step(`Running ${c.dim(`${runner.command} ${runner.args.join(" ")}`)}`);
  process.stdout.write("\n");

  let code: number;
  try {
    code = await runInstaller(runner, await readInstallRecord());
  } catch (err) {
    p.log.error(`The installer could not be started: ${err instanceof Error ? err.message : String(err)}`);
    p.note(manualInstallCommand(), pc.bold("Install manually with"));
    process.exitCode = 1;
    return;
  }

  if (code !== 0) {
    p.log.error(`The installer exited with code ${code}. veneko was left untouched.`);
    p.note(manualInstallCommand(), pc.bold("Try the published installer"));
    process.exitCode = code;
    return;
  }

  p.outro(`${c.success("✔")} veneko is now on ${c.highlight(release.tag)}. Run ${c.highlight("veneko doctor")} to confirm.`);
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description("Check GitHub for a newer release and install it")
    .option("--check", "only report whether an update is available")
    .option("-y, --yes", "install without asking for confirmation")
    .option("--force", "reinstall even when already on the latest release")
    .action(async (opts: { check?: boolean; yes?: boolean; force?: boolean }) => {
      await runUpdate({ checkOnly: opts.check, yes: opts.yes, force: opts.force });
    });
}
