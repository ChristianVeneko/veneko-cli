import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const prepareAudio = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>()
);

vi.mock("../src/tools/audio-prepare.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/audio-prepare.js")>();
  return { ...actual, prepareAudio };
});

const { convertAudioToMarkdown } = await import("../src/tools/audio-to-markdown.js");
const { buildPrepareArgs, uploadFileName, audioMimeType, isAudioFile } = await import(
  "../src/tools/audio-prepare.js"
);
const { buildGeminiTranscriptionPrompt } = await import("../src/ai/audio.js");

let workDir: string;
let audioPath: string;
let outputPath: string;

const transcription = { provider: "openai" as const, model: "whisper-1", apiKey: "test-key" };
const cleanupModel = { provider: "openai" as const, model: "gpt-4o", apiKey: "test-key" };

interface Reply {
  status: number;
  /** Transcription replies use `text`; chat replies use the OpenAI choices shape. */
  text: string;
}

/**
 * Answers both endpoints from one stub. The transcription endpoint and the chat
 * endpoint return different shapes, so the URL decides which one is sent back.
 */
function stubApi(handler: (callIndex: number, url: string) => Reply) {
  let callIndex = 0;

  const fetchMock = vi.fn(async (url: string) => {
    const reply = handler(callIndex, url);
    callIndex += 1;

    const isTranscription = url.includes("/audio/transcriptions");

    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () =>
        isTranscription
          ? { text: reply.text }
          : { choices: [{ message: { content: reply.text } }] },
      text: async () => reply.text,
    };
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stands in for ffmpeg: writes the segment files the real one would produce. */
async function fakePrepared(count: number) {
  const files: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const file = join(workDir, `chunk_${String(index).padStart(4, "0")}.mp3`);
    await writeFile(file, `segment-${index}`);
    files.push(file);
  }

  const cleanup = vi.fn(async () => {});
  return { files, mimeType: "audio/mpeg", cleanup };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "veneko-audio-"));
  audioPath = join(workDir, "voice note.ogg");
  outputPath = join(workDir, "voice note.md");
  await writeFile(audioPath, "not really ogg");
  prepareAudio.mockReset();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

describe("isAudioFile", () => {
  it("accepts the formats the tool advertises", () => {
    for (const name of ["a.mp3", "a.ogg", "a.opus", "a.M4A", "a.wav", "a.flac"]) {
      expect(isAudioFile(name)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isAudioFile("report.pdf")).toBe(false);
    expect(isAudioFile("noext")).toBe(false);
  });
});

describe("uploadFileName", () => {
  it("renames .opus and .oga to .ogg, which is the format OpenAI knows", () => {
    expect(uploadFileName("/tmp/PTT-2024.opus")).toBe("audio.ogg");
    expect(uploadFileName("/tmp/note.oga")).toBe("audio.ogg");
  });

  it("keeps every other extension", () => {
    expect(uploadFileName("/tmp/note.MP3")).toBe("audio.mp3");
  });
});

describe("audioMimeType", () => {
  it("maps the ogg family onto audio/ogg", () => {
    expect(audioMimeType("a.opus")).toBe("audio/ogg");
    expect(audioMimeType("a.oga")).toBe("audio/ogg");
    expect(audioMimeType("a.ogg")).toBe("audio/ogg");
  });

  it("falls back to a generic type instead of guessing", () => {
    expect(audioMimeType("a.aiff")).toBe("application/octet-stream");
  });
});

describe("buildPrepareArgs", () => {
  it("re-encodes to 16 kHz mono and segments in one pass", () => {
    const args = buildPrepareArgs("/in.m4a", "/out/chunk_%04d.mp3", 900);

    expect(args).toContain("-vn");
    expect(args.join(" ")).toContain("-ac 1");
    expect(args.join(" ")).toContain("-ar 16000");
    expect(args.join(" ")).toContain("-segment_time 900");
    expect(args.join(" ")).toContain("-reset_timestamps 1");
    expect(args[args.length - 1]).toBe("/out/chunk_%04d.mp3");
  });

  it("puts the input behind -i so a path starting with a dash is not read as a flag", () => {
    const args = buildPrepareArgs("-weird.mp3", "/out/chunk_%04d.mp3");
    expect(args[args.indexOf("-i") + 1]).toBe("-weird.mp3");
  });
});

describe("buildGeminiTranscriptionPrompt", () => {
  it("names the language when one is given", () => {
    expect(buildGeminiTranscriptionPrompt("es")).toContain("The audio is spoken in es.");
  });

  it("says nothing about the language when none is given", () => {
    expect(buildGeminiTranscriptionPrompt()).not.toContain("The audio is spoken in");
  });
});

describe("convertAudioToMarkdown", () => {
  it("transcribes the segments and formats the result", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(1));
    stubApi((_index, url) =>
      url.includes("/audio/transcriptions")
        ? { status: 200, text: "hola que tal todo bien" }
        : { status: 200, text: "## Saludo\n\nHola, que tal. Todo bien." }
    );

    const result = await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      cleanup: cleanupModel,
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    expect(result.segments).toBe(1);
    expect(result.prepared).toBe(true);
    expect(result.formatted).toBe(true);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).toContain("# voice note");
    expect(markdown).toContain("Todo bien.");
    expect(markdown).toContain("transcribed from voice note.ogg with whisper-1 (openai)");
  });

  it("writes the raw transcript when no formatting model is given", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(1));
    const fetchMock = stubApi(() => ({ status: 200, text: "raw words" }));

    const result = await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.formatted).toBe(false);
    expect(await readFile(outputPath, "utf-8")).toContain("raw words");
  });

  it("keeps the segments in recording order", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(3));
    let index = 0;
    stubApi(() => {
      const reply = { status: 200, text: `part-${index}` };
      index += 1;
      return reply;
    });

    const result = await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    expect(result.segments).toBe(3);
    expect(await readFile(outputPath, "utf-8")).toContain("part-0\n\npart-1\n\npart-2");
  });

  it("marks a failed segment and keeps the rest of the recording", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(3));
    // 401 is not retryable, so the second segment fails once and moves on.
    stubApi((callIndex) =>
      callIndex === 1 ? { status: 401, text: "bad key" } : { status: 200, text: "spoken words" }
    );

    const result = await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    expect(result.failedSegments).toEqual([2]);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).toContain("veneko: segment 2 failed");
    expect(markdown).toContain("spoken words");
  });

  it("fails the file when every segment fails, rather than writing an empty transcript", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(2));
    stubApi(() => ({ status: 401, text: "bad key" }));

    await expect(
      convertAudioToMarkdown({
        audioPath,
        outputPath,
        transcription,
        ffmpegPath: "/usr/bin/ffmpeg",
      })
    ).rejects.toThrow(/rejected the API key/);
  });

  it("removes the temporary segments even when the run fails", async () => {
    const prepared = await fakePrepared(1);
    prepareAudio.mockResolvedValue(prepared);
    stubApi(() => ({ status: 401, text: "bad key" }));

    await expect(
      convertAudioToMarkdown({
        audioPath,
        outputPath,
        transcription,
        ffmpegPath: "/usr/bin/ffmpeg",
      })
    ).rejects.toThrow();

    expect(prepared.cleanup).toHaveBeenCalled();
  });

  it("uploads the file untouched when ffmpeg is missing", async () => {
    const fetchMock = stubApi(() => ({ status: 200, text: "words" }));

    const result = await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      ffmpegPath: null,
    });

    expect(prepareAudio).not.toHaveBeenCalled();
    expect(result.prepared).toBe(false);
    expect(result.segments).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a format the provider cannot read when ffmpeg is missing", async () => {
    const weirdPath = join(workDir, "memo.aiff");
    await writeFile(weirdPath, "x");

    await expect(
      convertAudioToMarkdown({
        audioPath: weirdPath,
        outputPath,
        transcription,
        ffmpegPath: null,
      })
    ).rejects.toThrow(/ffmpeg/);
  });

  it("sends the language hint to the transcription endpoint", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(1));
    const fetchMock = stubApi(() => ({ status: 200, text: "hola" }));

    await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      language: "es",
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("language")).toBe("es");
    expect(form.get("model")).toBe("whisper-1");
    expect((form.get("file") as File).name).toBe("audio.mp3");
  });

  it("keeps the raw transcript of a fragment the formatting model drops", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(1));
    stubApi((_index, url) =>
      url.includes("/audio/transcriptions")
        ? { status: 200, text: "spoken content" }
        : { status: 200, text: "" }
    );

    const result = await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      cleanup: cleanupModel,
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    expect(result.failedChunks).toEqual([1]);
    expect(await readFile(outputPath, "utf-8")).toContain("spoken content");
  });

  it("reports progress for every stage and segment", async () => {
    prepareAudio.mockResolvedValue(await fakePrepared(2));
    stubApi(() => ({ status: 200, text: "words" }));

    const stages: string[] = [];
    const segments: number[] = [];

    await convertAudioToMarkdown({
      audioPath,
      outputPath,
      transcription,
      cleanup: cleanupModel,
      ffmpegPath: "/usr/bin/ffmpeg",
      onStage: (stage) => stages.push(stage),
      onSegmentDone: ({ completed, total }) => {
        expect(total).toBe(2);
        segments.push(completed);
      },
    });

    expect(stages).toEqual(["preparing", "transcribing", "formatting", "writing"]);
    expect(segments).toEqual([1, 2]);
  });
});
