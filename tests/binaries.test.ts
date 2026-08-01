import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

interface SpawnCall {
  command: string;
  args: string[];
  shell: boolean;
}

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));

const { resolveOnPath, needsShell, probeVersion } = await import("../src/utils/binaries.js");

let calls: SpawnCall[];

interface FakeProcess {
  code: number;
  stdout?: string;
}

/** Answers each spawn in order; the last entry repeats. */
function stubSpawn(processes: FakeProcess[]): void {
  let index = 0;

  spawn.mockImplementation(
    (command: string, args: string[], options: { shell?: boolean } = {}) => {
      calls.push({ command, args, shell: options.shell === true });

      const plan = processes[Math.min(index, processes.length - 1)];
      index += 1;

      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: () => void };
        stderr: EventEmitter & { setEncoding: () => void };
        kill: () => void;
      };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      child.kill = () => {};

      queueMicrotask(() => {
        if (plan.stdout) child.stdout.emit("data", plan.stdout);
        child.emit("close", plan.code);
      });

      return child;
    }
  );
}

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  calls = [];
  spawn.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe("resolveOnPath on Windows", () => {
  beforeEach(() => setPlatform("win32"));

  it("skips the extensionless shell script `where` lists first", async () => {
    // This is exactly what `where npm` prints. The first entry is a shell
    // script CreateProcess cannot launch, so choosing it reports an installed
    // npm as missing.
    stubSpawn([
      { code: 0, stdout: "C:\\Program Files\\nodejs\\npm\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n" },
    ]);

    expect(await resolveOnPath("npm")).toBe("C:\\Program Files\\nodejs\\npm.cmd");
  });

  it("keeps a plain .exe, which needs no special handling", async () => {
    stubSpawn([{ code: 0, stdout: "C:\\ffmpeg\\bin\\ffmpeg.exe\r\n" }]);
    expect(await resolveOnPath("ffmpeg")).toBe("C:\\ffmpeg\\bin\\ffmpeg.exe");
  });

  it("still skips the Microsoft Store stub before anything else", async () => {
    stubSpawn([
      {
        code: 0,
        stdout:
          "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\r\n" +
          "C:\\Python313\\python.exe\r\n",
      },
    ]);

    expect(await resolveOnPath("python")).toBe("C:\\Python313\\python.exe");
  });

  it("falls back to the first candidate when none has a known extension", async () => {
    stubSpawn([{ code: 0, stdout: "C:\\tools\\weird\r\n" }]);
    expect(await resolveOnPath("weird")).toBe("C:\\tools\\weird");
  });

  it("reports a binary that is not on PATH as missing", async () => {
    stubSpawn([{ code: 1 }]);
    expect(await resolveOnPath("nope")).toBeNull();
  });
});

describe("resolveOnPath on macOS and Linux", () => {
  beforeEach(() => setPlatform("darwin"));

  it("takes the first result, since extensions carry no meaning there", async () => {
    stubSpawn([{ code: 0, stdout: "/opt/homebrew/bin/node\n/usr/local/bin/node\n" }]);
    expect(await resolveOnPath("node")).toBe("/opt/homebrew/bin/node");
  });

  it("uses `which` rather than `where`", async () => {
    stubSpawn([{ code: 0, stdout: "/usr/bin/git\n" }]);
    await resolveOnPath("git");
    expect(calls[0].command).toBe("which");
  });
});

describe("needsShell", () => {
  it("is true only for the Windows batch wrappers Node refuses to spawn", () => {
    setPlatform("win32");
    expect(needsShell("C:\\Program Files\\nodejs\\npm.cmd")).toBe(true);
    expect(needsShell("C:\\tools\\thing.BAT")).toBe(true);
    expect(needsShell("C:\\ffmpeg\\bin\\ffmpeg.exe")).toBe(false);
  });

  it("is never true off Windows, where .cmd is just a filename", () => {
    setPlatform("linux");
    expect(needsShell("/usr/local/bin/thing.cmd")).toBe(false);
  });
});

describe("probeVersion", () => {
  it("runs a .cmd through a shell, with the path quoted for the spaces", async () => {
    setPlatform("win32");
    stubSpawn([
      { code: 0, stdout: "C:\\Program Files\\nodejs\\npm.cmd\r\n" },
      { code: 0, stdout: "11.12.1\n" },
    ]);

    expect(await probeVersion("npm")).toBe("11.12.1");

    const run = calls[1];
    expect(run.shell).toBe(true);
    expect(run.command).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
  });

  it("runs a real executable directly, without a shell", async () => {
    setPlatform("darwin");
    stubSpawn([
      { code: 0, stdout: "/usr/bin/git\n" },
      { code: 0, stdout: "git version 2.46.0\n" },
    ]);

    expect(await probeVersion("git")).toBe("git version 2.46.0");
    expect(calls[1].shell).toBe(false);
  });

  it("returns null when the binary is not installed at all", async () => {
    setPlatform("darwin");
    stubSpawn([{ code: 1 }]);
    expect(await probeVersion("nope")).toBeNull();
  });

  it("returns null when the binary is present but exits non-zero", async () => {
    setPlatform("darwin");
    stubSpawn([
      { code: 0, stdout: "/usr/bin/broken\n" },
      { code: 127, stdout: "" },
    ]);

    expect(await probeVersion("broken")).toBeNull();
  });

  it("keeps only the first line, since some tools print a banner", async () => {
    setPlatform("darwin");
    stubSpawn([
      { code: 0, stdout: "/usr/bin/ffmpeg\n" },
      { code: 0, stdout: "ffmpeg version 7.0\nbuilt with clang\nconfiguration: ...\n" },
    ]);

    expect(await probeVersion("ffmpeg", ["-version"])).toBe("ffmpeg version 7.0");
  });
});
