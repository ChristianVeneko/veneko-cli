import { readFile, stat, writeFile } from "fs/promises";
import { basename, extname } from "path";
import { audioSupport, transcribeAudio } from "../ai/audio.js";
import { completeText } from "../ai/text.js";
import { splitIntoChunks, stripOuterFence } from "./document-to-markdown.js";
import {
  audioMimeType,
  prepareAudio,
  uploadFileName,
  type PreparedAudio,
} from "./audio-prepare.js";
import type { ProviderId } from "../config/providers.js";

export const DEFAULT_CLEANUP_PROMPT = `You are turning a raw speech-to-text transcript into readable Markdown. The transcript is faithful but unformatted: no punctuation to speak of, no paragraphs, filler words, false starts and the odd misheard word.

Rewrite it as clean Markdown:
- Add punctuation, capitalization and paragraph breaks.
- Add ## headings when the speaker clearly moves to another topic.
- Drop filler and repeated false starts ("uh", "you know", a word said twice in a row).
- Fix a word the transcriber obviously misheard when the surrounding sentence makes the right one certain.
- Label the voices as **Speaker 1:**, **Speaker 2:** and so on when more than one person is audible.

Hard rules:
- Never invent, summarize, translate or omit content. Every idea the speaker expressed must survive, in their own words.
- Keep the original language of the recording.
- Keep [inaudible] markers exactly where they are.
- Return only the Markdown. No preamble, no commentary, no code fence around the whole answer.`;

export interface ModelCredentials {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

export interface AudioToMarkdownOptions {
  audioPath: string;
  outputPath: string;
  /** Model that turns the audio into text. */
  transcription: ModelCredentials;
  /** Model that formats the transcript. Omit to write the raw transcript. */
  cleanup?: ModelCredentials;
  /** ISO-639-1 hint such as "es". Omit to let the model detect the language. */
  language?: string;
  /**
   * Absolute path to ffmpeg. Without one the file is uploaded untouched, which
   * only works when its format and size already suit the provider.
   */
  ffmpegPath?: string | null;
  segmentSeconds?: number;
  prompt?: string;
  /** Approximate characters per formatting request. */
  chunkChars?: number;
  /** How many transcript fragments to format in parallel. */
  concurrency?: number;
  onStage?: (stage: "preparing" | "transcribing" | "formatting" | "writing") => void;
  onSegmentDone?: (info: { completed: number; total: number }) => void;
  onChunkDone?: (info: { completed: number; total: number }) => void;
}

export interface AudioToMarkdownResult {
  outputPath: string;
  /** Audio segments sent to the transcription model. */
  segments: number;
  /** 1-based indices of segments that failed; their place is marked in the text. */
  failedSegments: number[];
  /** True when ffmpeg re-encoded and split the audio first. */
  prepared: boolean;
  transcriptChars: number;
  formatted: boolean;
  /** 1-based indices of fragments the formatting model failed on. */
  failedChunks: number[];
}

/** Matches the document tool: roughly 3k tokens in, with room to write it back out. */
const DEFAULT_CHUNK_CHARS = 12_000;
const DEFAULT_CONCURRENCY = 3;

export const FFMPEG_AUDIO_HINT =
  "ffmpeg was not found. veneko uses it to re-encode and split recordings before\n" +
  "sending them, which is what makes long audio and formats like .m4a work.\n" +
  "Install it with one of:\n" +
  "  winget install Gyan.FFmpeg      (Windows)\n" +
  "  brew install ffmpeg             (macOS)\n" +
  "  sudo apt install ffmpeg         (Debian/Ubuntu)";

/**
 * Checks that a file can be uploaded as it is. Only reached when ffmpeg is
 * missing, so every failure here points at installing it rather than at the
 * recording, which the user cannot do anything about.
 */
async function validateRawUpload(audioPath: string, provider: ProviderId): Promise<void> {
  const support = audioSupport(provider);
  if (!support) {
    throw new Error(`${provider} cannot transcribe audio.`);
  }

  const mimeType = audioMimeType(audioPath);
  if (!support.mimeTypes.includes(mimeType)) {
    throw new Error(
      `${provider} does not accept ${extname(audioPath) || "this format"} directly.\n${FFMPEG_AUDIO_HINT}`
    );
  }

  const { size } = await stat(audioPath);
  if (size > support.maxBytes) {
    const limitMb = Math.round(support.maxBytes / (1024 * 1024));
    throw new Error(
      `This recording is ${Math.round(size / (1024 * 1024))} MB and ${provider} accepts ${limitMb} MB per request.\n${FFMPEG_AUDIO_HINT}`
    );
  }
}

/** Sends the segments one after another, so their order is the recording's order. */
async function transcribeSegments(
  segments: { path: string; mimeType: string }[],
  model: ModelCredentials,
  language: string | undefined,
  onSegmentDone?: (info: { completed: number; total: number }) => void
): Promise<{ transcript: string; failed: number[]; firstError: Error | null }> {
  const parts: string[] = [];
  const failed: number[] = [];
  let firstError: Error | null = null;

  for (const [index, segment] of segments.entries()) {
    try {
      const text = await transcribeAudio({
        provider: model.provider,
        model: model.model,
        apiKey: model.apiKey,
        audio: await readFile(segment.path),
        fileName: uploadFileName(segment.path),
        mimeType: segment.mimeType,
        language,
      });

      if (text.length > 0) {
        parts.push(text);
      } else {
        failed.push(index + 1);
        parts.push(`<!-- veneko: segment ${index + 1} came back empty -->`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      firstError ??= error;
      failed.push(index + 1);
      // The rest of the recording is still worth having, so a failed segment
      // leaves a marker instead of aborting the file.
      parts.push(
        `<!-- veneko: segment ${index + 1} failed — ${error.message.replace(/\s+/g, " ")} -->`
      );
    } finally {
      onSegmentDone?.({ completed: index + 1, total: segments.length });
    }
  }

  return { transcript: parts.join("\n\n"), failed, firstError };
}

function fragmentPrompt(basePrompt: string, index: number, total: number): string {
  if (total === 1) return basePrompt;

  return (
    `${basePrompt}\n\nThis is fragment ${index + 1} of ${total} from a longer transcript. ` +
    "Format only this fragment. Do not add an introduction or a conclusion, and do not " +
    "restate content from other fragments. It may begin or end mid-sentence — leave it that way."
  );
}

/** Formats the transcript in fragments, keeping their order and losing nothing. */
async function formatTranscript(
  transcript: string,
  model: ModelCredentials,
  prompt: string,
  chunkChars: number,
  concurrency: number,
  onChunkDone?: (info: { completed: number; total: number }) => void
): Promise<{ markdown: string; failed: number[] }> {
  const chunks = splitIntoChunks(transcript, chunkChars);
  const formatted: string[] = new Array(chunks.length).fill("");
  const failed: number[] = [];
  let completed = 0;

  for (let index = 0; index < chunks.length; index += concurrency) {
    const batch = chunks.slice(index, index + concurrency);

    await Promise.all(
      batch.map(async (chunk, offset) => {
        const position = index + offset;

        try {
          const result = await completeText({
            provider: model.provider,
            model: model.model,
            apiKey: model.apiKey,
            prompt: fragmentPrompt(prompt, position, chunks.length),
            input: chunk,
          });

          const cleaned = stripOuterFence(result);
          // An empty answer means the model dropped the fragment. Keep the raw
          // transcript rather than a hole in the document.
          formatted[position] = cleaned.length > 0 ? cleaned : chunk;
          if (cleaned.length === 0) failed.push(position + 1);
        } catch {
          formatted[position] = chunk;
          failed.push(position + 1);
        } finally {
          completed += 1;
          onChunkDone?.({ completed, total: chunks.length });
        }
      })
    );
  }

  return { markdown: formatted.join("\n\n").trim(), failed };
}

function buildDocument(audioPath: string, model: ModelCredentials, body: string): string {
  const title = basename(audioPath, extname(audioPath));

  return (
    `# ${title}\n\n` +
    `<!-- veneko: transcribed from ${basename(audioPath)} with ${model.model} (${model.provider}) -->\n\n` +
    `${body.trim()}\n`
  );
}

/**
 * Transcribes one audio file and writes it out as Markdown.
 *
 * The recording is re-encoded and cut into segments first whenever ffmpeg is
 * available, then transcribed segment by segment and — unless the caller asks
 * for the raw transcript — run through a language model that punctuates it and
 * breaks it into paragraphs.
 *
 * Nothing is discarded on failure: a segment the provider rejects leaves a
 * comment where it belongs and the rest of the recording still lands, and a
 * fragment the formatting model drops keeps its raw transcript.
 */
export async function convertAudioToMarkdown(
  options: AudioToMarkdownOptions
): Promise<AudioToMarkdownResult> {
  const {
    audioPath,
    outputPath,
    transcription,
    cleanup,
    language,
    ffmpegPath,
    segmentSeconds,
    prompt = DEFAULT_CLEANUP_PROMPT,
    chunkChars = DEFAULT_CHUNK_CHARS,
    concurrency = DEFAULT_CONCURRENCY,
    onStage,
    onSegmentDone,
    onChunkDone,
  } = options;

  onStage?.("preparing");

  let prepared: PreparedAudio | null = null;
  if (ffmpegPath) {
    prepared = await prepareAudio({ filePath: audioPath, ffmpegPath, segmentSeconds });
  } else {
    await validateRawUpload(audioPath, transcription.provider);
  }

  const segments = prepared
    ? prepared.files.map((path) => ({ path, mimeType: prepared!.mimeType }))
    : [{ path: audioPath, mimeType: audioMimeType(audioPath) }];

  let transcript: string;
  let failedSegments: number[];

  try {
    onStage?.("transcribing");
    const result = await transcribeSegments(segments, transcription, language, onSegmentDone);

    // Every segment failing is not a partial result, it is a broken run — and
    // the reason is the same for all of them, so it is worth surfacing.
    if (result.failed.length === segments.length && result.firstError) {
      throw result.firstError;
    }

    transcript = result.transcript;
    failedSegments = result.failed;
  } finally {
    await prepared?.cleanup();
  }

  let body = transcript;
  let failedChunks: number[] = [];

  if (cleanup) {
    onStage?.("formatting");
    const result = await formatTranscript(
      transcript,
      cleanup,
      prompt,
      chunkChars,
      concurrency,
      onChunkDone
    );
    body = result.markdown;
    failedChunks = result.failed;
  }

  onStage?.("writing");
  await writeFile(outputPath, buildDocument(audioPath, transcription, body), "utf-8");

  return {
    outputPath,
    segments: segments.length,
    failedSegments,
    prepared: prepared !== null,
    transcriptChars: transcript.length,
    formatted: cleanup !== undefined,
    failedChunks: failedChunks.sort((a, b) => a - b),
  };
}
