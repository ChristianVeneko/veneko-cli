import { spawn } from "child_process";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";

/** Extensions the tool offers to convert. mp3 and ogg are the common cases. */
export const AUDIO_EXTENSIONS = [
  ".mp3",
  ".ogg",
  ".oga",
  ".opus",
  ".m4a",
  ".mp4",
  ".aac",
  ".wav",
  ".flac",
  ".webm",
  ".mpga",
];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(filePath).toLowerCase());
}

/** Falls back to a generic type so an unknown extension fails at the provider, not here. */
export function audioMimeType(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Name the upload is sent under. OpenAI decides the audio format from the file
 * name, and its accepted list has no .opus or .oga in it — both of which are
 * Ogg files under another name, which is exactly what WhatsApp exports.
 * Renaming the upload is enough to have them read.
 *
 * The original name is dropped on purpose: it carries no meaning for the model
 * and a non-ASCII one only risks being mangled in the multipart header.
 */
export function uploadFileName(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const normalized = extension === ".opus" || extension === ".oga" ? ".ogg" : extension;
  return `audio${normalized}`;
}

/**
 * Segment length in seconds. Fifteen minutes is roughly 2,500 spoken words,
 * which fits every model's output budget with room to spare, and at the bitrate
 * below it is about 3.5 MB — well under the smallest provider limit.
 */
export const SEGMENT_SECONDS = 900;

/** Speech models resample to 16 kHz mono anyway, so sending more is paying for nothing. */
const PREPARED_SAMPLE_RATE = "16000";
const PREPARED_BITRATE = "32k";

export const PREPARED_EXTENSION = ".mp3";
export const PREPARED_MIME = "audio/mpeg";

/**
 * ffmpeg arguments that re-encode an audio file to 16 kHz mono MP3 and cut it
 * into fixed-length segments in one pass.
 *
 * Pure on purpose: every decision about what gets sent to the model is
 * inspectable without spawning anything.
 */
export function buildPrepareArgs(
  inputPath: string,
  outputPattern: string,
  segmentSeconds: number = SEGMENT_SECONDS
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    // Embedded cover art is a video stream, and the MP3 encoder chokes on it.
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    PREPARED_SAMPLE_RATE,
    "-c:a",
    "libmp3lame",
    "-b:a",
    PREPARED_BITRATE,
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    // Without this every segment after the first starts at its original
    // timestamp, which some decoders read as a long silence.
    "-reset_timestamps",
    "1",
    outputPattern,
  ];
}

const FFMPEG_TIMEOUT_MS = 1_800_000;

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);

    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("ffmpeg timed out while preparing the audio."));
    }, FFMPEG_TIMEOUT_MS);

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(new Error(`ffmpeg failed while preparing the audio.${detail ? `\n${detail}` : ""}`));
    });
  });
}

export interface PreparedAudio {
  /** Segment paths in playback order. */
  files: string[];
  mimeType: string;
  /** Removes the temporary directory the segments live in. */
  cleanup: () => Promise<void>;
}

/**
 * Re-encodes an audio file to a small, uniform format and splits it into
 * segments short enough for one model request.
 *
 * This runs on every file rather than only on oversized ones. Size alone is a
 * bad test: a 13 MB recording at a low bitrate is an hour long, fits any upload
 * limit, and still comes back with its transcript silently cut off at the
 * model's output ceiling. Re-encoding also settles format support, so a .opus
 * voice note and a .m4a memo take exactly the same path.
 */
export async function prepareAudio(options: {
  filePath: string;
  ffmpegPath: string;
  segmentSeconds?: number;
}): Promise<PreparedAudio> {
  const dir = await mkdtemp(join(tmpdir(), "veneko-audio-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    await runFfmpeg(
      options.ffmpegPath,
      buildPrepareArgs(
        options.filePath,
        join(dir, `chunk_%04d${PREPARED_EXTENSION}`),
        options.segmentSeconds
      )
    );

    const files = (await readdir(dir))
      .filter((name) => name.startsWith("chunk_") && name.endsWith(PREPARED_EXTENSION))
      // Zero-padded names, so lexical order is playback order.
      .sort()
      .map((name) => join(dir, name));

    if (files.length === 0) {
      throw new Error("ffmpeg produced no audio — the file may have no audio track.");
    }

    return { files, mimeType: PREPARED_MIME, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
