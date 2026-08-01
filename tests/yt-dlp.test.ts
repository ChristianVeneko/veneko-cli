import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  buildDownloadArgs,
  describeYtDlpFailure,
  detectFfmpeg,
  detectYtDlp,
  formatBytes,
  formatEta,
  formatSpeed,
  parseFileLine,
  parseProbeJson,
  parseProgressLine,
  probeUrl,
  resetYtDlpCache,
  runDownload,
  FFMPEG_INSTALL_HINT,
  YTDLP_INSTALL_HINT,
} = await import("../src/tools/yt-dlp.js");

type DownloadOptions = import("../src/tools/yt-dlp.js").DownloadOptions;

let calls: SpawnCall[];

/** Answers each spawn in order; the last entry repeats. */
function stubSpawn(processes: FakeProcess[]): void {
  let index = 0;

  spawn.mockImplementation((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options?.env ?? {} });

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

    setTimeout(() => {
      if (plan.spawnError) {
        child.emit("error", new Error("ENOENT"));
        return;
      }
      if (plan.stdout) child.stdout.emit("data", plan.stdout);
      if (plan.stderr) child.stderr.emit("data", plan.stderr);
      child.emit("close", plan.code);
    }, 0);

    return child;
  });
}

beforeEach(() => {
  calls = [];
  resetYtDlpCache();
  spawn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const YTDLP_BIN = "C:\\Users\\me\\AppData\\Local\\Programs\\yt-dlp.exe";
const PYTHON_BIN = "C:\\Python313\\python.exe";
const FFMPEG_BIN = "C:\\ffmpeg\\bin\\ffmpeg.exe";

const YTDLP_COMMAND = { command: YTDLP_BIN, baseArgs: [], label: "yt-dlp" };

/** A download with everything off, so each test only asserts what it enables. */
function baseOptions(overrides: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    outputDir: "C:\\Users\\me\\Downloads",
    mode: "video",
    hasFfmpeg: true,
    ...overrides,
  };
}

/** Reads the value that follows a flag, the way yt-dlp would. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("detectYtDlp", () => {
  it("prefers the standalone binary and returns its absolute path", async () => {
    stubSpawn([found(YTDLP_BIN)]);

    expect(await detectYtDlp()).toEqual({
      command: YTDLP_BIN,
      baseArgs: [],
      label: "yt-dlp",
    });
  });

  it("looks the binary up on PATH instead of running it", async () => {
    stubSpawn([found(YTDLP_BIN)]);

    await detectYtDlp();

    expect(calls[0].command).toMatch(/^(where|which)$/);
    expect(calls[0].args).toEqual(["yt-dlp"]);
  });

  it("falls back to python -m yt_dlp when the binary is missing", async () => {
    stubSpawn([NOT_FOUND, found(PYTHON_BIN)]);

    const command = await detectYtDlp();

    expect(command?.command).toBe(PYTHON_BIN);
    expect(command?.baseArgs).toEqual(["-m", "yt_dlp"]);
  });

  it("skips the Microsoft Store python stub, which never returns", async () => {
    stubSpawn([
      NOT_FOUND,
      { code: 0, stdout: `C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\n${PYTHON_BIN}\n` },
    ]);

    expect((await detectYtDlp())?.command).toBe(PYTHON_BIN);
  });

  it("returns null when no candidate is installed", async () => {
    stubSpawn([NOT_FOUND]);

    expect(await detectYtDlp()).toBeNull();
  });

  it("does not look up again once a command has been found", async () => {
    stubSpawn([found(YTDLP_BIN)]);

    await detectYtDlp();
    await detectYtDlp();

    expect(calls).toHaveLength(1);
  });
});

describe("detectFfmpeg", () => {
  it("returns the absolute path when ffmpeg is on PATH", async () => {
    stubSpawn([found(FFMPEG_BIN)]);

    expect(await detectFfmpeg()).toBe(FFMPEG_BIN);
  });

  it("returns null when ffmpeg is missing", async () => {
    stubSpawn([NOT_FOUND]);

    expect(await detectFfmpeg()).toBeNull();
  });
});

describe("buildDownloadArgs", () => {
  it("ignores the user's own yt-dlp config so the chosen options actually apply", () => {
    expect(buildDownloadArgs(baseOptions())).toContain("--ignore-config");
  });

  it("keeps progress visible even though --print implies --quiet", () => {
    const args = buildDownloadArgs(baseOptions());

    expect(args).toContain("--print");
    expect(args).toContain("--progress");
    expect(args).toContain("--no-simulate");
  });

  it("puts the URL last, after every flag", () => {
    const args = buildDownloadArgs(baseOptions());

    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("caps the resolution without rejecting streams of unknown height", () => {
    const args = buildDownloadArgs(baseOptions({ maxHeight: 1080 }));

    expect(valueOf(args, "-f")).toBe("bv*[height<=?1080]+ba/b[height<=?1080]/b");
  });

  it("asks for the best stream when no cap is set", () => {
    expect(valueOf(buildDownloadArgs(baseOptions({ maxHeight: "best" })), "-f")).toBe("bv*+ba/b");
  });

  it("prefers h264 and aac for mp4, the combination every player handles", () => {
    const args = buildDownloadArgs(baseOptions({ container: "mp4" }));

    expect(valueOf(args, "-S")).toBe("res,vcodec:h264,acodec:aac,ext:mp4:m4a");
    expect(valueOf(args, "--merge-output-format")).toBe("mp4");
  });

  it("stops asking for codecs when the container is mkv", () => {
    const args = buildDownloadArgs(baseOptions({ container: "mkv" }));

    expect(valueOf(args, "-S")).toBe("res,fps,vcodec,acodec");
    expect(valueOf(args, "--merge-output-format")).toBe("mkv");
  });

  it("falls back to a progressive stream when ffmpeg cannot merge", () => {
    const args = buildDownloadArgs(baseOptions({ hasFfmpeg: false, maxHeight: 1080 }));

    expect(valueOf(args, "-f")).toBe("b[height<=?1080][ext=mp4]/b[height<=?1080]/b");
    expect(args).not.toContain("--merge-output-format");
  });

  it("extracts audio at the requested format and quality", () => {
    const args = buildDownloadArgs(
      baseOptions({ mode: "audio", audioFormat: "mp3", audioQuality: "192K" })
    );

    expect(args).toContain("--extract-audio");
    expect(valueOf(args, "--audio-format")).toBe("mp3");
    expect(valueOf(args, "--audio-quality")).toBe("192K");
    expect(valueOf(args, "-f")).toBe("ba/b");
  });

  it("converts thumbnails to jpg for audio, since mp3 cannot carry webp", () => {
    const args = buildDownloadArgs(baseOptions({ mode: "audio", embedThumbnail: true }));

    expect(valueOf(args, "--convert-thumbnails")).toBe("jpg");
  });

  it("leaves video thumbnails in their original format", () => {
    const args = buildDownloadArgs(baseOptions({ embedThumbnail: true }));

    expect(args).toContain("--embed-thumbnail");
    expect(args).not.toContain("--convert-thumbnails");
  });

  it("refuses the playlist a single-video URL happens to belong to", () => {
    const args = buildDownloadArgs(baseOptions({ playlist: false }));

    expect(args).toContain("--no-playlist");
    expect(args).not.toContain("--yes-playlist");
  });

  it("numbers playlist files so they sort in playing order", () => {
    const args = buildDownloadArgs(baseOptions({ playlist: true, playlistItems: "1-10" }));

    expect(args).toContain("--yes-playlist");
    expect(valueOf(args, "--playlist-items")).toBe("1-10");
    expect(valueOf(args, "-o")).toContain("%(playlist_index)03d");
  });

  it("truncates long titles in bytes, which is what filesystems limit", () => {
    expect(valueOf(buildDownloadArgs(baseOptions()), "-o")).toBe("%(title).200B [%(id)s].%(ext)s");
  });

  it("writes auto-generated subtitles as srt in the requested languages", () => {
    const args = buildDownloadArgs(
      baseOptions({ subtitles: true, subtitleLangs: "es,en", embedSubs: true })
    );

    expect(args).toContain("--write-subs");
    expect(args).toContain("--write-auto-subs");
    expect(valueOf(args, "--sub-langs")).toBe("es,en");
    expect(valueOf(args, "--convert-subs")).toBe("srt");
    expect(args).toContain("--embed-subs");
  });

  it("does not ask for subtitles on an audio-only download", () => {
    const args = buildDownloadArgs(baseOptions({ mode: "audio", subtitles: true }));

    expect(args).not.toContain("--write-subs");
  });

  it("skips post-processing that needs ffmpeg when ffmpeg is absent", () => {
    const args = buildDownloadArgs(
      baseOptions({ hasFfmpeg: false, sponsorblock: true, subtitles: true, embedSubs: true })
    );

    expect(args).not.toContain("--sponsorblock-remove");
    expect(args).not.toContain("--embed-subs");
    // Writing the subtitle files still works — only muxing them needs ffmpeg.
    expect(args).toContain("--write-subs");
  });

  it("passes the cookie browser, archive and rate limit through", () => {
    const args = buildDownloadArgs(
      baseOptions({
        cookiesFromBrowser: "firefox",
        archivePath: "C:\\Users\\me\\Downloads\\veneko-archive.txt",
        limitRate: "2M",
      })
    );

    expect(valueOf(args, "--cookies-from-browser")).toBe("firefox");
    expect(valueOf(args, "--download-archive")).toBe("C:\\Users\\me\\Downloads\\veneko-archive.txt");
    expect(valueOf(args, "--limit-rate")).toBe("2M");
  });

  it("omits optional flags that were never asked for", () => {
    const args = buildDownloadArgs(baseOptions());

    expect(args).not.toContain("--cookies-from-browser");
    expect(args).not.toContain("--download-archive");
    expect(args).not.toContain("--limit-rate");
    expect(args).not.toContain("--embed-metadata");
  });
});

describe("parseProgressLine", () => {
  const line = "[veneko-progress]downloading|5242880|10485760|1048576.0|5";

  it("reads the fields yt-dlp reports", () => {
    expect(parseProgressLine(line)).toEqual({
      status: "downloading",
      downloadedBytes: 5242880,
      totalBytes: 10485760,
      speed: 1048576,
      eta: 5,
      percent: 50,
    });
  });

  it("treats yt-dlp's NA placeholders as unknown, not as zero", () => {
    const progress = parseProgressLine("[veneko-progress]downloading|1024|NA|NA|NA");

    expect(progress).toMatchObject({ totalBytes: null, speed: null, eta: null, percent: null });
  });

  it("ignores yt-dlp's own output lines", () => {
    expect(parseProgressLine("[download] Destination: video.mp4")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
  });

  it("never reports more than 100 percent when the size was an estimate", () => {
    expect(parseProgressLine("[veneko-progress]downloading|200|100|0|0")?.percent).toBe(100);
  });
});

describe("parseFileLine", () => {
  it("returns the path of a finished file", () => {
    expect(parseFileLine("[veneko-file]C:\\Users\\me\\Downloads\\song.mp3")).toBe(
      "C:\\Users\\me\\Downloads\\song.mp3"
    );
  });

  it("ignores every other line", () => {
    expect(parseFileLine("[ExtractAudio] Destination: song.mp3")).toBeNull();
  });
});

describe("formatting", () => {
  it("scales byte counts to a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10485760)).toBe("10.0 MB");
  });

  it("shows a placeholder while the size is still unknown", () => {
    expect(formatBytes(null)).toBe("?");
    expect(formatSpeed(null)).toBe("-- MB/s");
    expect(formatEta(null)).toBe("--:--");
  });

  it("writes an eta as mm:ss, and adds hours only when there are any", () => {
    expect(formatEta(65)).toBe("1:05");
    expect(formatEta(3725)).toBe("1:02:05");
  });
});

describe("describeYtDlpFailure", () => {
  it("points at the cookie option when YouTube demands a session", () => {
    const message = describeYtDlpFailure("ERROR: Sign in to confirm you're not a bot");

    expect(message).toMatch(/browser/i);
  });

  it("explains how to install ffmpeg when a merge was requested without it", () => {
    expect(describeYtDlpFailure("You have requested merging of multiple formats")).toBe(
      FFMPEG_INSTALL_HINT
    );
  });

  it("suggests a lower quality when no stream matched", () => {
    expect(describeYtDlpFailure("ERROR: Requested format is not available")).toMatch(
      /lower resolution/i
    );
  });

  it("blames the stale binary, not the quality, when the player cannot be decrypted", () => {
    const message = describeYtDlpFailure(
      "WARNING: [youtube] nsig extraction failed: Some formats may be missing\n" +
      "ERROR: Requested format is not available"
    );

    expect(message).toMatch(/changed\n?its player|player/i);
    expect(message).not.toMatch(/lower resolution/i);
  });

  it("does not let the version warning hijack an unrelated failure", () => {
    // An old install prints this warning on every single run, successful or not.
    const message = describeYtDlpFailure(
      "WARNING: Your yt-dlp version (2025.08.20) is older than 90 days!\n" +
      "ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found"
    );

    expect(message).toMatch(/could not be fetched/i);
  });

  it("blames a stale yt-dlp when extraction itself breaks", () => {
    expect(describeYtDlpFailure("ERROR: Unable to extract player response")).toMatch(/-U|upgrade/);
  });

  it("explains how to install yt-dlp when python has no module for it", () => {
    expect(describeYtDlpFailure("No module named yt_dlp")).toBe(YTDLP_INSTALL_HINT);
  });

  it("falls back to the tail of the output for anything unrecognised", () => {
    expect(describeYtDlpFailure("ERROR: something new broke")).toMatch(/something new broke/);
  });
});

describe("parseProbeJson", () => {
  it("reads a single video", () => {
    const info = parseProbeJson(
      JSON.stringify({
        _type: "video",
        title: "Never Gonna Give You Up",
        channel: "Rick Astley",
        duration: 213,
        extractor_key: "Youtube",
      })
    );

    expect(info).toEqual({
      title: "Never Gonna Give You Up",
      uploader: "Rick Astley",
      duration: 213,
      isPlaylist: false,
      entryCount: 1,
      extractor: "Youtube",
    });
  });

  it("counts the entries of a playlist", () => {
    const info = parseProbeJson(
      JSON.stringify({ _type: "playlist", title: "Mix", entries: [{}, {}, {}] })
    );

    expect(info.isPlaylist).toBe(true);
    expect(info.entryCount).toBe(3);
  });

  it("fails loudly when the output is not the JSON it expects", () => {
    expect(() => parseProbeJson("not json")).toThrow(/could not read/i);
  });
});

describe("probeUrl", () => {
  it("reads metadata without downloading or expanding the playlist", async () => {
    stubSpawn([{ code: 0, stdout: JSON.stringify({ title: "Clip", duration: 10 }) }]);

    const info = await probeUrl("https://youtu.be/x", { command: YTDLP_COMMAND });

    expect(info.title).toBe("Clip");
    expect(calls[0].args).toContain("--dump-single-json");
    expect(calls[0].args).toContain("--flat-playlist");
  });

  it("reports the real reason when the URL cannot be read", async () => {
    stubSpawn([{ code: 1, stderr: "ERROR: Private video" }]);

    await expect(probeUrl("https://youtu.be/x", { command: YTDLP_COMMAND })).rejects.toThrow(
      /private/i
    );
  });
});

describe("runDownload", () => {
  it("returns the paths yt-dlp reports, not paths guessed from the template", async () => {
    stubSpawn([
      {
        code: 0,
        stdout:
          "[veneko-progress]downloading|100|200|50|2\n" +
          "[veneko-file]C:\\Users\\me\\Downloads\\Clip [abc].mp4\n",
      },
    ]);

    const result = await runDownload({ ...baseOptions(), command: YTDLP_COMMAND });

    expect(result.files).toEqual(["C:\\Users\\me\\Downloads\\Clip [abc].mp4"]);
  });

  it("reports progress as it arrives, including carriage-return updates", async () => {
    stubSpawn([
      {
        code: 0,
        stdout:
          "[veneko-progress]downloading|50|200|50|3\r" +
          "[veneko-progress]downloading|100|200|50|2\r" +
          "[veneko-progress]finished|200|200|NA|NA\n",
      },
    ]);

    const percents: (number | null)[] = [];
    await runDownload({
      ...baseOptions(),
      command: YTDLP_COMMAND,
      onProgress: (progress) => percents.push(progress.percent),
    });

    expect(percents).toEqual([25, 50, 100]);
  });

  it("counts finished files as they land, for playlist progress", async () => {
    stubSpawn([
      {
        code: 0,
        stdout: "[veneko-file]a.mp4\n[veneko-file]b.mp4\n[veneko-file]c.mp4\n",
      },
    ]);

    const done: number[] = [];
    await runDownload({
      ...baseOptions({ playlist: true }),
      command: YTDLP_COMMAND,
      onFileDone: (_file, completed) => done.push(completed),
    });

    expect(done).toEqual([1, 2, 3]);
  });

  it("keeps a partly finished playlist and surfaces the failed items", async () => {
    stubSpawn([
      {
        code: 1,
        stdout: "[veneko-file]a.mp4\n",
        stderr: "ERROR: [youtube] zzz: Private video\n",
      },
    ]);

    const result = await runDownload({
      ...baseOptions({ playlist: true }),
      command: YTDLP_COMMAND,
    });

    expect(result.files).toEqual(["a.mp4"]);
    expect(result.warnings[0]).toMatch(/Private video/);
  });

  it("throws when nothing was downloaded at all", async () => {
    stubSpawn([{ code: 1, stderr: "ERROR: Video unavailable" }]);

    await expect(runDownload({ ...baseOptions(), command: YTDLP_COMMAND })).rejects.toThrow(
      /not available/i
    );
  });

  it("refuses an audio download before spawning anything when ffmpeg is missing", async () => {
    stubSpawn([{ code: 0 }]);

    await expect(
      runDownload({ ...baseOptions({ mode: "audio", hasFfmpeg: false }), command: YTDLP_COMMAND })
    ).rejects.toThrow(FFMPEG_INSTALL_HINT);
    expect(calls).toHaveLength(0);
  });

  it("forces UTF-8 so non-ASCII titles survive on Windows", async () => {
    stubSpawn([{ code: 0, stdout: "[veneko-file]canción.mp4\n" }]);

    await runDownload({ ...baseOptions(), command: YTDLP_COMMAND });

    expect(calls[0].env.PYTHONIOENCODING).toBe("utf-8");
  });
});
