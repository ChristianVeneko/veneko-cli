import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface FakeProcess {
  /** Exit code the process reports. */
  code: number;
  stdout?: string;
  stderr?: string;
  /** Written to the path given after `-o`, simulating a real conversion. */
  output?: string;
  /** Makes spawn itself fail, as it does for a command that is not installed. */
  spawnError?: boolean;
}

/** What `where`/`which` reports for a binary that is on PATH. */
function found(path: string): FakeProcess {
  return { code: 0, stdout: `${path}\n` };
}

/** What `where`/`which` reports for a binary that is not on PATH. */
const NOT_FOUND: FakeProcess = { code: 1 };

const spawn = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ spawn }));

const {
  detectMarkitdown,
  extractMarkdown,
  resetMarkitdownCache,
  MARKITDOWN_INSTALL_HINT,
} = await import("../src/tools/markitdown.js");

let calls: SpawnCall[];

/** Answers each spawn in order; the last entry repeats. */
function stubSpawn(processes: FakeProcess[]): void {
  let index = 0;

  spawn.mockImplementation((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });

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

    setTimeout(async () => {
      if (plan.spawnError) {
        child.emit("error", new Error("ENOENT"));
        return;
      }
      if (plan.stdout) child.stdout.emit("data", plan.stdout);
      if (plan.stderr) child.stderr.emit("data", plan.stderr);

      const outFlag = args.indexOf("-o");
      if (plan.output !== undefined && outFlag !== -1) {
        await writeFile(args[outFlag + 1], plan.output, "utf-8");
      }

      child.emit("close", plan.code);
    }, 0);

    return child;
  });
}

let workDir: string;
let docPath: string;

beforeEach(async () => {
  calls = [];
  resetMarkitdownCache();
  spawn.mockReset();
  workDir = await mkdtemp(join(tmpdir(), "veneko-mid-"));
  docPath = join(workDir, "report.docx");
  await writeFile(docPath, "not really a docx");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

const MARKITDOWN_BIN = "C:\\Python313\\Scripts\\markitdown.exe";
const PYTHON_BIN = "C:\\Python313\\python.exe";

describe("detectMarkitdown", () => {
  it("prefers the standalone binary and returns its absolute path", async () => {
    stubSpawn([found(MARKITDOWN_BIN)]);

    const command = await detectMarkitdown();

    expect(command).toEqual({
      command: MARKITDOWN_BIN,
      baseArgs: [],
      label: "markitdown",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["markitdown"]);
  });

  it("looks the binary up on PATH instead of running it", async () => {
    stubSpawn([found(MARKITDOWN_BIN)]);

    await detectMarkitdown();

    // A cold markitdown import takes over ten seconds, so detection must never
    // execute it just to find out whether it is there.
    expect(calls[0].args).not.toContain("--version");
    expect(calls[0].command).toMatch(/^(where|which)$/);
  });

  it("falls back to python -m markitdown when the binary is missing", async () => {
    stubSpawn([NOT_FOUND, found(PYTHON_BIN)]);

    const command = await detectMarkitdown();

    expect(command?.command).toBe(PYTHON_BIN);
    expect(command?.baseArgs).toEqual(["-m", "markitdown"]);
    expect(command?.label).toBe("python -m markitdown");
  });

  it("skips the Microsoft Store python stub, which never returns", async () => {
    stubSpawn([
      NOT_FOUND,
      { code: 0, stdout: `C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\n${PYTHON_BIN}\n` },
    ]);

    expect((await detectMarkitdown())?.command).toBe(PYTHON_BIN);
  });

  it("returns null when no candidate is installed", async () => {
    stubSpawn([NOT_FOUND]);

    expect(await detectMarkitdown()).toBeNull();
  });

  it("treats a lookup that cannot even spawn as not installed", async () => {
    stubSpawn([{ code: 0, spawnError: true }]);

    expect(await detectMarkitdown()).toBeNull();
  });

  it("does not look up again once a command has been found", async () => {
    stubSpawn([found(MARKITDOWN_BIN)]);

    await detectMarkitdown();
    await detectMarkitdown();

    expect(calls).toHaveLength(1);
  });
});

describe("extractMarkdown", () => {
  it("reads the converted markdown from the output file", async () => {
    stubSpawn([found(MARKITDOWN_BIN), { code: 0, output: "# Report\n\nBody" }]);

    expect(await extractMarkdown(docPath)).toBe("# Report\n\nBody");
  });

  it("writes to a file instead of parsing stdout, to keep UTF-8 intact", async () => {
    stubSpawn([found(MARKITDOWN_BIN), { code: 0, output: "café ñandú" }]);

    const markdown = await extractMarkdown(docPath);

    expect(markdown).toBe("café ñandú");
    const convertCall = calls[1];
    expect(convertCall.args).toContain("-o");
    expect(convertCall.args[convertCall.args.indexOf("-o") + 1]).toMatch(/\.md$/);
  });

  it("normalizes the CRLF line endings markitdown writes on Windows", async () => {
    stubSpawn([found(MARKITDOWN_BIN), { code: 0, output: "# Title\r\n\r\nBody\r\n" }]);

    expect(await extractMarkdown(docPath)).toBe("# Title\n\nBody");
  });

  it("forces UTF-8 on the Python side", async () => {
    stubSpawn([found(MARKITDOWN_BIN), { code: 0, output: "ok" }]);

    await extractMarkdown(docPath);

    expect(calls[1].env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("explains how to install markitdown when it is absent", async () => {
    stubSpawn([NOT_FOUND]);

    await expect(extractMarkdown(docPath)).rejects.toThrow(MARKITDOWN_INSTALL_HINT);
  });

  it("explains how to install when python has no markitdown module", async () => {
    stubSpawn([
      NOT_FOUND,
      found(PYTHON_BIN),
      { code: 1, stderr: "No module named markitdown" },
    ]);

    await expect(extractMarkdown(docPath)).rejects.toThrow(/pip install/);
  });

  it("surfaces a missing optional dependency with the install command", async () => {
    stubSpawn([
      found(MARKITDOWN_BIN),
      { code: 1, stderr: "MissingDependencyException: DocxConverter requires mammoth" },
    ]);

    await expect(extractMarkdown(docPath)).rejects.toThrow(/markitdown\[all\]/);
  });

  it("points at the scanned-PDF tool when the document has no text layer", async () => {
    stubSpawn([found(MARKITDOWN_BIN), { code: 0, output: "   \n  " }]);

    await expect(extractMarkdown(docPath)).rejects.toThrow(/Scanned PDF to Markdown/);
  });

  it("removes its temporary directory after a successful run", async () => {
    stubSpawn([found(MARKITDOWN_BIN), { code: 0, output: "done" }]);

    await extractMarkdown(docPath);

    const outFile = calls[1].args[calls[1].args.indexOf("-o") + 1];
    await expect(readFile(outFile, "utf-8")).rejects.toThrow();
  });

  it("reuses a command it is handed instead of looking one up", async () => {
    stubSpawn([{ code: 0, output: "body" }]);

    const markdown = await extractMarkdown(docPath, {
      command: { command: PYTHON_BIN, baseArgs: ["-m", "markitdown"], label: "python -m markitdown" },
    });

    expect(markdown).toBe("body");
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 3)).toEqual(["-m", "markitdown", docPath]);
  });
});
