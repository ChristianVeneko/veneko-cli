import { spawn } from "child_process";
import { resolveOnPath } from "../utils/binaries.js";

/**
 * yt-dlp is a Python program, not a Node one. veneko shells out to whatever
 * entry point the machine has instead of shipping a port of it.
 */
export interface YtDlpCommand {
  /** Absolute path to the executable, so no shell resolution is needed. */
  command: string;
  /** Leading arguments, before the ones for the download itself. */
  baseArgs: string[];
  /** Human-readable form, for diagnostics. */
  label: string;
}

interface Candidate {
  binary: string;
  baseArgs: string[];
}

/** Tried in order; the first one present on PATH wins. */
const CANDIDATES: Candidate[] = [
  { binary: "yt-dlp", baseArgs: [] },
  { binary: "python", baseArgs: ["-m", "yt_dlp"] },
  { binary: "python3", baseArgs: ["-m", "yt_dlp"] },
  // The Windows Python launcher, for installs that are not on PATH as `python`.
  { binary: "py", baseArgs: ["-m", "yt_dlp"] },
];

export const YTDLP_INSTALL_HINT =
  "yt-dlp was not found. Install it with one of:\n" +
  "  winget install yt-dlp.yt-dlp    (Windows)\n" +
  "  brew install yt-dlp             (macOS)\n" +
  "  pipx install yt-dlp             (any platform with Python 3.9+)\n" +
  "See https://github.com/yt-dlp/yt-dlp#installation";

export const FFMPEG_INSTALL_HINT =
  "ffmpeg was not found. yt-dlp needs it to merge separate video and audio\n" +
  "streams and to convert audio, so without it quality is capped and MP3 is\n" +
  "unavailable. Install it with one of:\n" +
  "  winget install Gyan.FFmpeg      (Windows)\n" +
  "  brew install ffmpeg             (macOS)\n" +
  "  sudo apt install ffmpeg         (Debian/Ubuntu)";

export const YTDLP_UPDATE_HINT =
  "This usually means yt-dlp is out of date — YouTube changes its player often.\n" +
  "Update it with `yt-dlp -U`, `pipx upgrade yt-dlp` or `winget upgrade yt-dlp.yt-dlp`.";

let cachedYtDlp: YtDlpCommand | null | undefined;
let cachedFfmpeg: string | null | undefined;

/**
 * Finds a usable yt-dlp entry point, or null when none is installed.
 * The result is cached for the process — installs do not appear mid-session.
 */
export async function detectYtDlp(): Promise<YtDlpCommand | null> {
  if (cachedYtDlp !== undefined) return cachedYtDlp;

  for (const candidate of CANDIDATES) {
    const resolved = await resolveOnPath(candidate.binary);
    if (resolved) {
      cachedYtDlp = {
        command: resolved,
        baseArgs: candidate.baseArgs,
        label: [candidate.binary, ...candidate.baseArgs].join(" "),
      };
      return cachedYtDlp;
    }
  }

  cachedYtDlp = null;
  return null;
}

/** Absolute path to ffmpeg, or null when it is not installed. */
export async function detectFfmpeg(): Promise<string | null> {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;

  cachedFfmpeg = await resolveOnPath("ffmpeg");
  return cachedFfmpeg;
}

/** Exposed for tests; production code has no reason to call these. */
export function resetYtDlpCache(): void {
  cachedYtDlp = undefined;
  cachedFfmpeg = undefined;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DownloadMode = "video" | "audio";
export type VideoContainer = "mp4" | "mkv";
export type AudioFormat = "mp3" | "m4a" | "opus" | "flac" | "wav";

export interface DownloadOptions {
  url: string;
  /** Directory the finished files land in. */
  outputDir: string;
  mode: DownloadMode;
  /** Max height in pixels, or "best" for no cap. Video mode only. */
  maxHeight?: number | "best";
  container?: VideoContainer;
  audioFormat?: AudioFormat;
  /** yt-dlp `--audio-quality`: "0" is best VBR, or a bitrate like "192K". */
  audioQuality?: string;
  /** False downloads only the video a playlist URL points at. */
  playlist?: boolean;
  /** yt-dlp `--playlist-items` range, e.g. "1-10,15". */
  playlistItems?: string;
  embedThumbnail?: boolean;
  embedMetadata?: boolean;
  embedChapters?: boolean;
  /** Writes subtitle files, including auto-generated ones. Video mode only. */
  subtitles?: boolean;
  subtitleLangs?: string;
  /** Also muxes the subtitles into the container. */
  embedSubs?: boolean;
  /** Cuts sponsor segments out of the file via SponsorBlock. */
  sponsorblock?: boolean;
  /** Browser to lift cookies from, for age-restricted or members-only videos. */
  cookiesFromBrowser?: string;
  /** Records finished IDs so re-runs skip them. */
  archivePath?: string;
  /** yt-dlp `--limit-rate`, e.g. "2M". */
  limitRate?: string;
  concurrentFragments?: number;
  /** Drives the fallbacks that keep a download working without ffmpeg. */
  hasFfmpeg?: boolean;
}

/** Marks the lines veneko parses, so they cannot be confused with yt-dlp's own. */
const PROGRESS_PREFIX = "[veneko-progress]";
const FILE_PREFIX = "[veneko-file]";

/**
 * Machine-readable progress, in place of the human progress bar. `total_bytes`
 * is unknown until a fragment lands, so the estimate is the fallback.
 */
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|` +
  `%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`;

/** Truncation is in bytes (`B`), which is what filesystems actually limit. */
function outputTemplate(options: DownloadOptions): string {
  if (options.playlist) {
    return "%(playlist_title).100B/%(playlist_index)03d - %(title).150B [%(id)s].%(ext)s";
  }
  return "%(title).200B [%(id)s].%(ext)s";
}

function videoFormat(options: DownloadOptions): string[] {
  // Without ffmpeg nothing can be merged, so only a progressive stream (audio
  // and video already in one file) is usable — usually 720p at most.
  if (!options.hasFfmpeg) {
    const cap = typeof options.maxHeight === "number" ? `[height<=?${options.maxHeight}]` : "";
    return ["-f", cap ? `b${cap}[ext=mp4]/b${cap}/b` : "b[ext=mp4]/b"];
  }

  const cap = typeof options.maxHeight === "number" ? `[height<=?${options.maxHeight}]` : "";
  // The last fallback drops the cap on purpose: a video whose only stream is
  // above the requested height should still download rather than fail.
  const args = ["-f", cap ? `bv*${cap}+ba/b${cap}/b` : "bv*+ba/b"];

  const container = options.container ?? "mp4";
  if (container === "mp4") {
    // H.264 + AAC in mp4 is the combination every player and phone handles.
    args.push("-S", "res,vcodec:h264,acodec:aac,ext:mp4:m4a");
  } else {
    args.push("-S", "res,fps,vcodec,acodec");
  }
  args.push("--merge-output-format", container);

  return args;
}

function audioFormat(options: DownloadOptions): string[] {
  return [
    "-f",
    "ba/b",
    "--extract-audio",
    "--audio-format",
    options.audioFormat ?? "mp3",
    "--audio-quality",
    options.audioQuality ?? "0",
  ];
}

/**
 * Builds the full yt-dlp argument list. Pure on purpose: every decision about
 * what gets downloaded is inspectable and testable without spawning anything.
 */
export function buildDownloadArgs(options: DownloadOptions): string[] {
  const args = [
    // A user's own ~/.config/yt-dlp config would silently override these.
    "--ignore-config",
    "--no-color",
    "--newline",
    // `--print` implies `--quiet`, which would hide progress without this.
    "--progress",
    "--no-simulate",
    "--print",
    `after_move:${FILE_PREFIX}%(filepath)s`,
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--concurrent-fragments",
    String(options.concurrentFragments ?? 4),
    "-P",
    options.outputDir,
    "-o",
    outputTemplate(options),
  ];

  args.push(options.playlist ? "--yes-playlist" : "--no-playlist");
  if (options.playlist && options.playlistItems) {
    args.push("--playlist-items", options.playlistItems);
  }

  args.push(...(options.mode === "audio" ? audioFormat(options) : videoFormat(options)));

  if (options.subtitles && options.mode === "video") {
    args.push(
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      options.subtitleLangs ?? "es,en",
      "--convert-subs",
      "srt"
    );
    if (options.embedSubs && options.hasFfmpeg) args.push("--embed-subs");
  }

  if (options.embedThumbnail) {
    args.push("--embed-thumbnail");
    // YouTube serves WebP thumbnails, which mp3 and m4a cannot carry.
    if (options.mode === "audio") args.push("--convert-thumbnails", "jpg");
  }
  if (options.embedMetadata) args.push("--embed-metadata");
  if (options.embedChapters && options.mode === "video") args.push("--embed-chapters");

  if (options.sponsorblock && options.hasFfmpeg) {
    args.push("--sponsorblock-remove", "sponsor,selfpromo,interaction,intro,outro,music_offtopic");
  }

  if (options.cookiesFromBrowser) {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }
  if (options.archivePath) args.push("--download-archive", options.archivePath);
  if (options.limitRate) args.push("--limit-rate", options.limitRate);

  args.push(options.url);

  return args;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  status: string;
  downloadedBytes: number | null;
  totalBytes: number | null;
  /** Bytes per second. */
  speed: number | null;
  /** Seconds remaining. */
  eta: number | null;
  /** 0-100, or null while the total size is still unknown. */
  percent: number | null;
}

/** yt-dlp prints "NA" for every field it does not know yet. */
function numberOrNull(raw: string): number | null {
  const value = Number(raw);
  return raw === "NA" || raw.length === 0 || Number.isNaN(value) ? null : value;
}

/** Returns null for any line that is not one of veneko's progress lines. */
export function parseProgressLine(line: string): DownloadProgress | null {
  const start = line.indexOf(PROGRESS_PREFIX);
  if (start === -1) return null;

  const fields = line.slice(start + PROGRESS_PREFIX.length).split("|");
  if (fields.length < 5) return null;

  const downloadedBytes = numberOrNull(fields[1]);
  const totalBytes = numberOrNull(fields[2]);

  return {
    status: fields[0].trim(),
    downloadedBytes,
    totalBytes,
    speed: numberOrNull(fields[3]),
    eta: numberOrNull(fields[4]),
    percent:
      downloadedBytes !== null && totalBytes !== null && totalBytes > 0
        ? Math.min(100, (downloadedBytes / totalBytes) * 100)
        : null,
  };
}

/** Returns the finished file path a `--print after_move` line carries. */
export function parseFileLine(line: string): string | null {
  const start = line.indexOf(FILE_PREFIX);
  if (start === -1) return null;

  const path = line.slice(start + FILE_PREFIX.length).trim();
  return path.length > 0 ? path : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "?";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "-- MB/s" : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return "--:--";

  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Turns yt-dlp's stderr into something a user can act on. Every branch here is
 * a failure that has a specific fix — anything else falls through to the raw
 * tail of the output.
 */
export function describeYtDlpFailure(stderr: string): string {
  const detail = stderr.trim().split("\n").slice(-8).join("\n");

  if (/No module named ['"]?yt_dlp/i.test(stderr)) {
    return YTDLP_INSTALL_HINT;
  }
  if (/confirm you'?re not a bot|Sign in to confirm your age|age.restricted|LOGIN_REQUIRED/i.test(stderr)) {
    return (
      "YouTube wants a signed-in session for this video.\n" +
      "Re-run the tool and pick a browser under advanced options — veneko will\n" +
      "reuse its cookies. Make sure that browser is fully closed first.\n" +
      detail
    );
  }
  if (/only available to (this channel'?s )?members|members-only/i.test(stderr)) {
    return `This video is members-only. It needs the cookies of an account that is a member.\n${detail}`;
  }
  if (/Private video|This video is private/i.test(stderr)) {
    return `This video is private, so it cannot be downloaded.\n${detail}`;
  }
  if (/Video unavailable|has been removed|account associated with this video has been terminated/i.test(stderr)) {
    return `The video is not available anymore.\n${detail}`;
  }
  if (/not available in your country|blocked it in your country|geo.restricted/i.test(stderr)) {
    return `The video is geo-blocked for this connection.\n${detail}`;
  }
  if (/ffmpeg (is )?not (found|installed)|ffprobe.*not found|You have requested merging/i.test(stderr)) {
    return FFMPEG_INSTALL_HINT;
  }
  if (/Unable to download webpage|HTTP Error 40[34]|HTTP Error 5\d\d/i.test(stderr)) {
    return `The URL could not be fetched — check that it is still online.\n${detail}`;
  }
  // Checked before the format branch: a stale yt-dlp cannot decrypt stream URLs,
  // so YouTube reports no usable formats and the real cause is the version.
  // The "older than N days" warning is deliberately not matched here: it is
  // printed on every run of an old install and would hijack unrelated errors.
  if (/nsig extraction failed|SABR|missing a url/i.test(stderr)) {
    return (
      "yt-dlp could not read the stream URLs for this video — YouTube changed\n" +
      `its player and this build no longer follows it.\n${YTDLP_UPDATE_HINT}\n` +
      detail
    );
  }
  if (/Requested format is not available/i.test(stderr)) {
    return (
      "yt-dlp could not find a stream matching that quality.\n" +
      "Try a lower resolution, or install ffmpeg so separate video and audio\n" +
      "streams can be merged.\n" +
      detail
    );
  }
  if (/HTTP Error 429|Too Many Requests/i.test(stderr)) {
    return `YouTube is rate-limiting this connection. Wait a few minutes and try again.\n${detail}`;
  }
  if (/Unsupported URL|is not a valid URL/i.test(stderr)) {
    return `yt-dlp does not know how to handle that URL.\n${detail}`;
  }
  if (/Unable to extract|nsig extraction failed|Precondition check failed|player response/i.test(stderr)) {
    return `yt-dlp could not read the page.\n${YTDLP_UPDATE_HINT}\n${detail}`;
  }

  return `yt-dlp failed.\n${detail}`;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 3_600_000;
const PROBE_TIMEOUT_MS = 120_000;

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunHandlers {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

/**
 * Runs yt-dlp, handing every output line to the caller as it arrives.
 * Progress is worthless if it only shows up once the process is done.
 */
function run(
  command: YtDlpCommand,
  args: string[],
  timeoutMs: number,
  handlers: RunHandlers = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.baseArgs, ...args], {
      // yt-dlp run through `python -m` pipes its output using the locale
      // encoding, which mangles non-ASCII titles on Windows.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 60000)} minute(s).`));
    }, timeoutMs);

    // Progress updates arrive as carriage returns, not newlines, so a plain
    // line splitter would hold the whole download in one buffer.
    const feed = (buffer: string, chunk: string, emit?: (line: string) => void): string => {
      const combined = buffer + chunk;
      const parts = combined.split(/[\r\n]+/);
      const remainder = parts.pop() ?? "";
      if (emit) {
        for (const part of parts) {
          if (part.length > 0) emit(part);
        }
      }
      return remainder;
    };

    let outBuffer = "";
    let errBuffer = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      outBuffer = feed(outBuffer, chunk, handlers.onStdoutLine);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      errBuffer = feed(errBuffer, chunk, handlers.onStderrLine);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (outBuffer.length > 0) handlers.onStdoutLine?.(outBuffer);
      if (errBuffer.length > 0) handlers.onStderrLine?.(errBuffer);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface MediaInfo {
  title: string;
  uploader: string | null;
  /** Seconds, when the extractor reports one. */
  duration: number | null;
  isPlaylist: boolean;
  /** Number of videos in the playlist; 1 for a single video. */
  entryCount: number;
  extractor: string | null;
}

export interface ProbeOptions {
  command?: YtDlpCommand;
  cookiesFromBrowser?: string;
  timeoutMs?: number;
}

/**
 * Reads the metadata of a URL without downloading anything, so the user sees
 * what they are about to pull — and whether it is a whole playlist.
 *
 * `--flat-playlist` keeps this to a single request: resolving every entry of a
 * 500-video playlist would take minutes.
 */
export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  const command = options.command ?? (await detectYtDlp());
  if (!command) throw new Error(YTDLP_INSTALL_HINT);

  const args = [
    "--ignore-config",
    "--no-color",
    "--no-warnings",
    "--dump-single-json",
    "--flat-playlist",
    // Metadata is still worth showing when no stream can be resolved: the user
    // gets the title and a real error at download time, not a dead end here.
    "--ignore-no-formats-error",
    "--socket-timeout",
    "20",
  ];
  if (options.cookiesFromBrowser) {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }
  args.push(url);

  const result = await run(command, args, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(describeYtDlpFailure(result.stderr || result.stdout));
  }

  return parseProbeJson(result.stdout);
}

/** Split out from `probeUrl` so the shape handling can be tested on its own. */
export function parseProbeJson(raw: string): MediaInfo {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("yt-dlp returned metadata veneko could not read.");
  }

  const entries = Array.isArray(info.entries) ? info.entries : null;
  const isPlaylist = info._type === "playlist" || entries !== null;

  return {
    title: typeof info.title === "string" ? info.title : "Untitled",
    uploader:
      typeof info.uploader === "string"
        ? info.uploader
        : typeof info.channel === "string"
          ? info.channel
          : null,
    duration: typeof info.duration === "number" ? info.duration : null,
    isPlaylist,
    entryCount: entries?.length ?? (typeof info.playlist_count === "number" ? info.playlist_count : 1),
    extractor: typeof info.extractor_key === "string" ? info.extractor_key : null,
  };
}

export interface RunDownloadOptions extends DownloadOptions {
  command?: YtDlpCommand;
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Fires once per finished file, with how many are done so far. */
  onFileDone?: (filePath: string, completed: number) => void;
}

export interface DownloadResult {
  files: string[];
  /** Non-fatal errors — a playlist keeps going when one entry fails. */
  warnings: string[];
}

/**
 * Downloads a URL and resolves with the files that ended up on disk.
 *
 * Finished paths come from `--print after_move:filepath` rather than from
 * guessing the output template: post-processing changes both the extension and
 * the name, so only yt-dlp knows where the file actually landed.
 */
export async function runDownload(options: RunDownloadOptions): Promise<DownloadResult> {
  const command = options.command ?? (await detectYtDlp());
  if (!command) throw new Error(YTDLP_INSTALL_HINT);

  if (options.mode === "audio" && !options.hasFfmpeg) {
    throw new Error(FFMPEG_INSTALL_HINT);
  }

  const files: string[] = [];
  const errorLines: string[] = [];

  const result = await run(
    command,
    buildDownloadArgs(options),
    options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    {
      onStdoutLine: (line) => {
        const progress = parseProgressLine(line);
        if (progress) {
          options.onProgress?.(progress);
          return;
        }

        const file = parseFileLine(line);
        if (file) {
          files.push(file);
          options.onFileDone?.(file, files.length);
        }
      },
      onStderrLine: (line) => {
        if (/^\s*ERROR/i.test(line)) errorLines.push(line.trim());
      },
    }
  );

  if (result.code !== 0 && files.length === 0) {
    throw new Error(describeYtDlpFailure(result.stderr || result.stdout));
  }

  return { files, warnings: files.length > 0 ? errorLines : [] };
}
