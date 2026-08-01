import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const extractMarkdown = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());

vi.mock("../src/tools/markitdown.js", () => ({
  extractMarkdown,
  MARKITDOWN_EXTENSIONS: [".docx"],
  MARKITDOWN_INSTALL_HINT: "install markitdown",
}));

const {
  convertDocumentToMarkdown,
  splitIntoChunks,
  stripOuterFence,
} = await import("../src/tools/document-to-markdown.js");

let workDir: string;
let outputPath: string;

/** Replies to every formatting call with text derived from the call order. */
function stubTextApi(handler: (callIndex: number) => { status: number; text: string }) {
  let callIndex = 0;

  const fetchMock = vi.fn(async () => {
    const reply = handler(callIndex);
    callIndex += 1;

    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => ({ choices: [{ message: { content: reply.text } }] }),
      text: async () => reply.text,
    };
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function baseOptions() {
  return {
    filePath: join(workDir, "report.docx"),
    outputPath,
    provider: "openai" as const,
    model: "gpt-4o",
    apiKey: "test-key",
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "veneko-doc-"));
  outputPath = join(workDir, "report.md");
  extractMarkdown.mockReset();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

describe("splitIntoChunks", () => {
  it("keeps a short document in a single chunk", () => {
    expect(splitIntoChunks("one\n\ntwo", 100)).toEqual(["one\n\ntwo"]);
  });

  it("breaks on blank lines rather than mid-paragraph", () => {
    const chunks = splitIntoChunks("aaaa\n\nbbbb\n\ncccc", 10);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
    expect(chunks.join("\n\n")).toBe("aaaa\n\nbbbb\n\ncccc");
  });

  it("splits a paragraph that alone exceeds the limit on line boundaries", () => {
    const block = ["line one", "line two", "line three"].join("\n");

    const chunks = splitIntoChunks(block, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => !chunk.includes("line one\nline two\nline three"))).toBe(true);
  });

  it("drops blank runs without losing content", () => {
    expect(splitIntoChunks("a\n\n\n\n\nb", 100)).toEqual(["a\n\nb"]);
  });

  it("breaks on CRLF paragraphs too, since markitdown emits them on Windows", () => {
    const chunks = splitIntoChunks("aaaa\r\n\r\nbbbb\r\n\r\ncccc", 10);

    expect(chunks).toEqual(["aaaa\n\nbbbb", "cccc"]);
  });
});

describe("stripOuterFence", () => {
  it("unwraps a fence around the whole answer", () => {
    expect(stripOuterFence("```markdown\n# Title\n```")).toBe("# Title");
  });

  it("leaves inner code blocks alone", () => {
    const text = "# Title\n\n```js\nconst a = 1;\n```\n\nAfter";
    expect(stripOuterFence(text)).toBe(text);
  });
});

describe("convertDocumentToMarkdown", () => {
  it("extracts with markitdown and formats the result with the model", async () => {
    extractMarkdown.mockResolvedValue("raw   extracted   text");
    stubTextApi(() => ({ status: 200, text: "# Clean" }));

    const result = await convertDocumentToMarkdown(baseOptions());

    expect(extractMarkdown).toHaveBeenCalledWith(
      join(workDir, "report.docx"),
      expect.anything()
    );
    expect(result.formatted).toBe(true);
    expect(result.chunks).toBe(1);
    expect(await readFile(outputPath, "utf-8")).toBe("# Clean\n");
  });

  it("sends one request per chunk and stitches them in order", async () => {
    extractMarkdown.mockResolvedValue("aaaa\n\nbbbb\n\ncccc");
    const fetchMock = stubTextApi((index) => ({ status: 200, text: `part-${index}` }));

    const result = await convertDocumentToMarkdown({
      ...baseOptions(),
      chunkChars: 5,
      concurrency: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.chunks).toBe(3);
    expect(await readFile(outputPath, "utf-8")).toBe("part-0\n\npart-1\n\npart-2\n");
  });

  it("keeps chunk order even when formatted concurrently", async () => {
    extractMarkdown.mockResolvedValue("aaaa\n\nbbbb\n\ncccc\n\ndddd");
    let index = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const current = index;
        index += 1;
        // Earlier chunks resolve last, so ordering cannot come from timing.
        await new Promise((resolve) => setTimeout(resolve, (4 - current) * 5));
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: `part-${current}` } }] }),
          text: async () => "",
        };
      })
    );

    await convertDocumentToMarkdown({ ...baseOptions(), chunkChars: 5, concurrency: 4 });

    expect(await readFile(outputPath, "utf-8")).toBe("part-0\n\npart-1\n\npart-2\n\npart-3\n");
  });

  it("does not send the document to a model when raw is set", async () => {
    extractMarkdown.mockResolvedValue("# Raw output");
    const fetchMock = stubTextApi(() => ({ status: 200, text: "unused" }));

    const result = await convertDocumentToMarkdown({ ...baseOptions(), raw: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.formatted).toBe(false);
    expect(await readFile(outputPath, "utf-8")).toBe("# Raw output\n");
  });

  it("keeps the raw text of a chunk the model fails on", async () => {
    extractMarkdown.mockResolvedValue("aaaa\n\nbbbb");
    // The second request fails with a non-retryable auth error.
    stubTextApi((index) =>
      index === 1 ? { status: 401, text: "bad key" } : { status: 200, text: "formatted" }
    );

    const result = await convertDocumentToMarkdown({
      ...baseOptions(),
      chunkChars: 5,
      concurrency: 1,
    });

    expect(result.failedChunks).toEqual([2]);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).toContain("formatted");
    expect(markdown).toContain("bbbb");
  });

  it("falls back to the raw text when the model returns nothing", async () => {
    extractMarkdown.mockResolvedValue("original content");
    stubTextApi(() => ({ status: 200, text: "" }));

    const result = await convertDocumentToMarkdown(baseOptions());

    expect(result.failedChunks).toEqual([1]);
    expect(await readFile(outputPath, "utf-8")).toBe("original content\n");
  });

  it("passes the extracted markdown as the model input, not the file path", async () => {
    extractMarkdown.mockResolvedValue("extracted body");
    const fetchMock = stubTextApi(() => ({ status: 200, text: "ok" }));

    await convertDocumentToMarkdown(baseOptions());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: { content: { text?: string }[] }[];
    };
    expect(body.messages[0].content[0].text).toContain("extracted body");
    expect(body.messages[0].content).toHaveLength(1);
  });

  it("tells the model a fragment is part of a longer document", async () => {
    extractMarkdown.mockResolvedValue("aaaa\n\nbbbb");
    const fetchMock = stubTextApi(() => ({ status: 200, text: "ok" }));

    await convertDocumentToMarkdown({ ...baseOptions(), chunkChars: 5, concurrency: 1 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: { content: { text?: string }[] }[];
    };
    expect(body.messages[0].content[0].text).toContain("fragment 1 of 2");
  });

  it("reports progress for each finished chunk", async () => {
    extractMarkdown.mockResolvedValue("aaaa\n\nbbbb\n\ncccc");
    stubTextApi(() => ({ status: 200, text: "ok" }));

    const stages: string[] = [];
    const seen: number[] = [];

    await convertDocumentToMarkdown({
      ...baseOptions(),
      chunkChars: 5,
      onStage: (stage) => stages.push(stage),
      onChunkDone: ({ completed, total }) => {
        expect(total).toBe(3);
        seen.push(completed);
      },
    });

    expect(stages).toEqual(["extracting", "formatting", "writing"]);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("surfaces an extraction failure instead of writing an empty file", async () => {
    extractMarkdown.mockRejectedValue(new Error("markitdown failed."));

    await expect(convertDocumentToMarkdown(baseOptions())).rejects.toThrow(/markitdown failed/);
  });
});
