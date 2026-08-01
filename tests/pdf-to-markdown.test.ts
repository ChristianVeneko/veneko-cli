import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { convertPdfToMarkdown } from "../src/tools/pdf-to-markdown.js";
import { buildMinimalPdf } from "./helpers/minimal-pdf.js";

let workDir: string;
let pdfPath: string;
let outputPath: string;

/** Replies to every vision call with text derived from the call order. */
function stubVisionApi(handler: (callIndex: number) => { status: number; text: string }) {
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

function firstImageDataUri(fetchMock: ReturnType<typeof stubVisionApi>): string {
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
    messages: { content: { image_url?: { url: string } }[] }[];
  };
  return body.messages[0].content[1].image_url?.url ?? "";
}

/** Reads dimensions from the first JPEG start-of-frame marker. */
function jpegSize(buffer: Buffer): { width: number; height: number } {
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0-SOF3 and SOF5-SOF15 carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + buffer.readUInt16BE(offset + 2);
  }

  throw new Error("No JPEG start-of-frame marker found.");
}

function baseOptions() {
  return {
    pdfPath,
    outputPath,
    provider: "openai" as const,
    model: "gpt-4o",
    apiKey: "test-key",
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "veneko-pdf-"));
  pdfPath = join(workDir, "scan.pdf");
  outputPath = join(workDir, "scan.md");
  await writeFile(pdfPath, buildMinimalPdf(["Page One", "Page Two", "Page Three"]));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

describe("convertPdfToMarkdown", () => {
  it("transcribes every page and writes the markdown to disk", async () => {
    stubVisionApi((index) => ({ status: 200, text: `# Transcribed ${index + 1}` }));

    const result = await convertPdfToMarkdown(baseOptions());

    expect(result.pagesProcessed).toBe(3);
    expect(result.failedPages).toEqual([]);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).toContain("<!-- Page 1 -->");
    expect(markdown).toContain("<!-- Page 3 -->");
    expect(markdown).toContain("# Transcribed 1");
  });

  it("sends one request per page", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "text" }));
    await convertPdfToMarkdown(baseOptions());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps pages in document order even when transcribed concurrently", async () => {
    stubVisionApi((index) => ({ status: 200, text: `content-${index}` }));

    await convertPdfToMarkdown({ ...baseOptions(), concurrency: 3 });

    const markdown = await readFile(outputPath, "utf-8");
    const pageOrder = [...markdown.matchAll(/<!-- Page (\d+) -->/g)].map((m) => Number(m[1]));
    expect(pageOrder).toEqual([1, 2, 3]);
  });

  it("sends a rasterized JPEG of the page, not the raw PDF", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "ok" }));

    await convertPdfToMarkdown(baseOptions());

    const dataUri = firstImageDataUri(fetchMock);
    expect(dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);

    const jpeg = Buffer.from(dataUri.split(",")[1], "base64");
    // JPEG SOI marker.
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpeg.length).toBeGreaterThan(500);
  });

  it("caps the rendered image at maxEdge so providers do not reject it", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "ok" }));

    await convertPdfToMarkdown({ ...baseOptions(), dpi: 600, maxEdge: 400 });

    const jpeg = Buffer.from(firstImageDataUri(fetchMock).split(",")[1], "base64");
    const { width, height } = jpegSize(jpeg);
    expect(Math.max(width, height)).toBeLessThanOrEqual(400);
  });

  it("does not upscale a page beyond the requested dpi", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "ok" }));

    // The fixture is 300pt square, so 72 dpi means a 300px render even though
    // maxEdge would allow far more.
    await convertPdfToMarkdown({ ...baseOptions(), dpi: 72, maxEdge: 4000 });

    const jpeg = Buffer.from(firstImageDataUri(fetchMock).split(",")[1], "base64");
    expect(Math.max(...Object.values(jpegSize(jpeg)))).toBe(300);
  });

  it("honours a page range instead of the whole document", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "ranged" }));

    const result = await convertPdfToMarkdown({ ...baseOptions(), firstPage: 2, lastPage: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.pagesProcessed).toBe(2);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).not.toContain("<!-- Page 1 -->");
    expect(markdown).toContain("<!-- Page 2 -->");
  });

  it("rejects an impossible page range", async () => {
    stubVisionApi(() => ({ status: 200, text: "unused" }));

    await expect(
      convertPdfToMarkdown({ ...baseOptions(), firstPage: 3, lastPage: 2 })
    ).rejects.toThrow(/Invalid page range/);
  });

  it("clamps a range that runs past the last page", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "ok" }));

    const result = await convertPdfToMarkdown({ ...baseOptions(), firstPage: 2, lastPage: 99 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.pagesProcessed).toBe(2);
  });

  it("reports progress for each finished page", async () => {
    stubVisionApi(() => ({ status: 200, text: "ok" }));
    const seen: number[] = [];

    await convertPdfToMarkdown({
      ...baseOptions(),
      onPageDone: ({ completed, total }) => {
        expect(total).toBe(3);
        seen.push(completed);
      },
    });

    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("marks a failed page in the output instead of losing the whole run", async () => {
    // The second request fails with a non-retryable auth error.
    stubVisionApi((index) =>
      index === 1 ? { status: 401, text: "bad key" } : { status: 200, text: "good page" }
    );

    const result = await convertPdfToMarkdown({ ...baseOptions(), concurrency: 1 });

    expect(result.failedPages).toEqual([2]);
    expect(result.pagesProcessed).toBe(2);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).toMatch(/<!-- veneko: page 2 failed/);
    expect(markdown).toContain("good page");
  });

  it("uses the transcription prompt as the text part of the request", async () => {
    const fetchMock = stubVisionApi(() => ({ status: 200, text: "ok" }));

    await convertPdfToMarkdown({ ...baseOptions(), prompt: "CUSTOM PROMPT" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: { content: { text?: string }[] }[];
    };
    expect(body.messages[0].content[0].text).toBe("CUSTOM PROMPT");
  });
});
