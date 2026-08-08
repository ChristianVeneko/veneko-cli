import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildFigurePdf } from "./helpers/figure-pdf.js";

const extractMarkdown = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());

vi.mock("../src/tools/markitdown.js", () => ({
  extractMarkdown,
  MARKITDOWN_EXTENSIONS: [".pdf"],
  MARKITDOWN_INSTALL_HINT: "install markitdown",
}));

const { convertDocumentToMarkdown, NOT_A_FIGURE } = await import(
  "../src/tools/document-to-markdown.js"
);

/** Text printed in the PDF, and therefore what pdf.js reports as the anchor. */
const LEAD_IN = "and then introduces the diagram that follows";
const TRAILER = "The text after the diagram continues here";

let workDir: string;
let pdfPath: string;
let outputPath: string;

interface StubbedCall {
  /** Prompt text of the request. */
  prompt: string;
  /** True when the request carried an image, i.e. it was a figure. */
  isVision: boolean;
}

/**
 * Stubs the provider API, routing figure requests and formatting requests to
 * separate handlers so each can be asserted on independently.
 */
function stubApi(handlers: {
  figure?: (call: number) => { status: number; text: string };
  format?: (input: string) => { status: number; text: string };
}) {
  const calls: StubbedCall[] = [];
  let figureCalls = 0;

  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    const content = body.messages[0].content;
    const prompt = content.find((part) => part.type === "text")?.text ?? "";
    const isVision = content.some((part) => part.type === "image_url");

    calls.push({ prompt, isVision });

    let reply: { status: number; text: string };

    if (isVision) {
      reply = handlers.figure?.(figureCalls) ?? { status: 200, text: "figure content" };
      figureCalls += 1;
    } else {
      // The document the formatting pass was given, unwrapped from its fence.
      const document = prompt.match(/<document>\n([\s\S]*)\n<\/document>/)?.[1] ?? "";
      reply = handlers.format?.(document) ?? { status: 200, text: document };
    }

    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => ({ choices: [{ message: { content: reply.text } }] }),
      text: async () => reply.text,
    };
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function baseOptions() {
  return {
    filePath: pdfPath,
    outputPath,
    provider: "openai" as const,
    model: "gpt-4o",
    apiKey: "test-key",
    figures: true,
  };
}

/** A PDF whose printed text matches what the mocked extraction returns. */
async function writeOneFigurePdf(): Promise<void> {
  await writeFile(
    pdfPath,
    buildFigurePdf([
      {
        text: [
          { y: 560, content: "Chapter one opens with a paragraph of prose" },
          { y: 520, content: LEAD_IN },
          { y: 200, content: TRAILER },
        ],
        images: [{ x: 40, y: 260, width: 200, height: 150 }],
      },
    ])
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "veneko-docfig-"));
  pdfPath = join(workDir, "manual.pdf");
  outputPath = join(workDir, "manual.md");
  extractMarkdown.mockReset();
  extractMarkdown.mockResolvedValue(
    [
      "Chapter one opens with a paragraph of prose",
      LEAD_IN,
      `${TRAILER}.`,
    ].join("\n\n")
  );
  await writeOneFigurePdf();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

describe("convertDocumentToMarkdown with figures", () => {
  it("splices a described figure between the paragraphs it sat between", async () => {
    stubApi({
      figure: () => ({ status: 200, text: "```mermaid\nflowchart TD\n  A --> B\n```" }),
    });

    const result = await convertDocumentToMarkdown(baseOptions());

    expect(result.figuresFound).toBe(1);
    expect(result.figuresDescribed).toBe(1);
    expect(result.failedFigures).toEqual([]);
    expect(result.figuresAppended).toBe(0);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown.indexOf(LEAD_IN)).toBeLessThan(markdown.indexOf("flowchart TD"));
    expect(markdown.indexOf("flowchart TD")).toBeLessThan(markdown.indexOf(TRAILER));
  });

  it("keeps the mermaid fence intact instead of unwrapping it", async () => {
    stubApi({
      figure: () => ({ status: 200, text: "```mermaid\nflowchart TD\n  A --> B\n```" }),
    });

    await convertDocumentToMarkdown(baseOptions());

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).toContain("```mermaid\nflowchart TD");
    expect(markdown).toContain("\n```");
  });

  it("never shows the figure's markdown to the formatting model", async () => {
    const { calls } = stubApi({
      figure: () => ({ status: 200, text: "```mermaid\nflowchart TD\n  A --> B\n```" }),
    });

    await convertDocumentToMarkdown(baseOptions());

    const formatting = calls.filter((call) => !call.isVision);
    expect(formatting).toHaveLength(1);
    expect(formatting[0].prompt).not.toContain("flowchart TD");
    // It sees only the placeholder standing in for the figure.
    expect(formatting[0].prompt).toContain("<!-- veneko:figure p1#1 -->");
  });

  it("tells the formatting model to preserve the placeholders", async () => {
    const { calls } = stubApi({});

    await convertDocumentToMarkdown(baseOptions());

    const formatting = calls.find((call) => !call.isVision);
    expect(formatting?.prompt).toContain("veneko:figure");
    expect(formatting?.prompt).toMatch(/verbatim/i);
  });

  it("sends the cropped figure as a JPEG, one request per figure", async () => {
    const { fetchMock, calls } = stubApi({});

    await convertDocumentToMarkdown(baseOptions());

    expect(calls.filter((call) => call.isVision)).toHaveLength(1);

    const visionBody = fetchMock.mock.calls
      .map((call) => JSON.parse((call[1] as { body: string }).body))
      .find((body) =>
        body.messages[0].content.some((part: { type: string }) => part.type === "image_url")
      );
    const url = visionBody.messages[0].content.find(
      (part: { type: string }) => part.type === "image_url"
    ).image_url.url;

    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("uses the figure prompt, not the formatting prompt, for images", async () => {
    const { calls } = stubApi({});

    await convertDocumentToMarkdown({ ...baseOptions(), figurePrompt: "READ THIS FIGURE" });

    const vision = calls.find((call) => call.isVision);
    expect(vision?.prompt).toBe("READ THIS FIGURE");
  });

  it("recovers the figure when the formatting model drops the placeholder", async () => {
    stubApi({
      figure: () => ({ status: 200, text: "Circuit: R1 10k between V+ and node A." }),
      // A model that silently deletes the comment.
      format: (document) => ({
        status: 200,
        text: document.replace(/<!--[\s\S]*?-->/g, "").trim(),
      }),
    });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresAppended).toBe(1);
    expect(markdown).toContain("Figures without a detected position");
    expect(markdown).toContain("Circuit: R1 10k between V+ and node A.");
  });

  it("appends a figure whose anchor is missing from the extraction", async () => {
    // The extraction shares no wording with the PDF's text layer.
    extractMarkdown.mockResolvedValue("Totally unrelated extracted content.");
    stubApi({ figure: () => ({ status: 200, text: "Described figure." }) });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresFound).toBe(1);
    expect(result.figuresAppended).toBe(1);
    expect(markdown).toContain("### Figure — page 1");
    expect(markdown).toContain("Described figure.");
  });

  it("marks a figure the vision model failed on without losing its place", async () => {
    stubApi({ figure: () => ({ status: 401, text: "bad key" }) });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresDescribed).toBe(0);
    expect(result.failedFigures).toEqual(["p1#1"]);
    expect(markdown).toMatch(/veneko: figure p1#1 failed/);
  });

  it("reports progress for each figure", async () => {
    stubApi({});
    const seen: number[] = [];

    await convertDocumentToMarkdown({
      ...baseOptions(),
      onFigureDone: ({ completed, total }) => {
        expect(total).toBe(1);
        seen.push(completed);
      },
    });

    expect(seen).toEqual([1]);
  });

  it("reports the scanning and describing stages", async () => {
    stubApi({});
    const stages: string[] = [];

    await convertDocumentToMarkdown({
      ...baseOptions(),
      onStage: (stage) => stages.push(stage),
    });

    expect(stages).toContain("scanning-figures");
    expect(stages).toContain("describing-figures");
    expect(stages.indexOf("scanning-figures")).toBeLessThan(stages.indexOf("formatting"));
  });

  it("substitutes figures in raw mode too, with no formatting request", async () => {
    const { calls } = stubApi({ figure: () => ({ status: 200, text: "Raw figure text." }) });

    const result = await convertDocumentToMarkdown({ ...baseOptions(), raw: true });
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.formatted).toBe(false);
    expect(calls.filter((call) => !call.isVision)).toHaveLength(0);
    expect(markdown).toContain("Raw figure text.");
    expect(markdown.indexOf(LEAD_IN)).toBeLessThan(markdown.indexOf("Raw figure text."));
  });

  it("does no figure work when the option is off", async () => {
    const { calls } = stubApi({});

    const result = await convertDocumentToMarkdown({ ...baseOptions(), figures: false });

    expect(result.figuresFound).toBe(0);
    expect(calls.filter((call) => call.isVision)).toHaveLength(0);

    const markdown = await readFile(outputPath, "utf-8");
    expect(markdown).not.toContain("veneko:figure");
  });

  it("skips figure detection for a format that is not a PDF", async () => {
    const docxPath = join(workDir, "report.docx");
    await writeFile(docxPath, "not really a docx");
    const { calls } = stubApi({});

    const result = await convertDocumentToMarkdown({ ...baseOptions(), filePath: docxPath });

    expect(result.figuresFound).toBe(0);
    expect(calls.filter((call) => call.isVision)).toHaveLength(0);
  });

  it("finds a vector diagram that has no embedded image at all", async () => {
    await writeFile(
      pdfPath,
      buildFigurePdf([
        {
          text: [
            { y: 560, content: LEAD_IN },
            { y: 180, content: TRAILER },
          ],
          strokedBoxes: [
            { x: 60, y: 400, width: 120, height: 60 },
            { x: 60, y: 280, width: 120, height: 60 },
          ],
          lines: [{ from: [120, 400], to: [120, 340] }],
        },
      ])
    );
    stubApi({ figure: () => ({ status: 200, text: "```mermaid\nflowchart TD\n  A --> B\n```" }) });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresFound).toBe(1);
    expect(result.figuresDescribed).toBe(1);
    expect(markdown.indexOf(LEAD_IN)).toBeLessThan(markdown.indexOf("flowchart TD"));
    expect(markdown.indexOf("flowchart TD")).toBeLessThan(markdown.indexOf(TRAILER));
  });

  it("drops a region the model says is not a figure, leaving no trace", async () => {
    stubApi({ figure: () => ({ status: 200, text: NOT_A_FIGURE }) });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresFound).toBe(1);
    expect(result.figuresRejected).toBe(1);
    expect(result.figuresDescribed).toBe(0);
    expect(result.failedFigures).toEqual([]);
    expect(result.figuresAppended).toBe(0);

    expect(markdown).not.toContain("veneko:figure");
    expect(markdown).not.toContain(NOT_A_FIGURE);
    // The surrounding text is untouched.
    expect(markdown).toContain(LEAD_IN);
    expect(markdown).toContain(TRAILER);
  });

  it("does not append a rejected region to the fallback section", async () => {
    extractMarkdown.mockResolvedValue("Unrelated extracted content with no shared wording.");
    stubApi({ figure: () => ({ status: 200, text: `${NOT_A_FIGURE}.` }) });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresRejected).toBe(1);
    expect(result.figuresAppended).toBe(0);
    expect(markdown).not.toContain("Figures without a detected position");
  });

  it("gives the model an explicit way to reject a crop", async () => {
    const { calls } = stubApi({});

    await convertDocumentToMarkdown(baseOptions());

    const vision = calls.find((call) => call.isVision);
    expect(vision?.prompt).toContain(NOT_A_FIGURE);
    expect(vision?.prompt).toMatch(/table/i);
  });

  it("keeps a description that merely mentions the sentinel", async () => {
    // A real answer long enough to be content must not be mistaken for a refusal.
    const answer =
      `The flowchart's second node is labelled ${NOT_A_FIGURE}, which is a state ` +
      "in the diagram and not a verdict about the crop itself.";
    stubApi({ figure: () => ({ status: 200, text: answer }) });

    const result = await convertDocumentToMarkdown(baseOptions());

    expect(result.figuresRejected).toBe(0);
    expect(result.figuresDescribed).toBe(1);
  });

  it("keeps two figures on one page in the order they appear", async () => {
    await writeFile(
      pdfPath,
      buildFigurePdf([
        {
          text: [
            { y: 560, content: LEAD_IN },
            { y: 300, content: TRAILER },
          ],
          images: [
            { x: 40, y: 380, width: 200, height: 120 },
            { x: 40, y: 100, width: 200, height: 120 },
          ],
        },
      ])
    );
    stubApi({ figure: (call) => ({ status: 200, text: `FIGURE-${call + 1}` }) });

    const result = await convertDocumentToMarkdown(baseOptions());
    const markdown = await readFile(outputPath, "utf-8");

    expect(result.figuresFound).toBe(2);
    expect(result.figuresDescribed).toBe(2);
    expect(markdown.indexOf("FIGURE-1")).toBeGreaterThan(-1);
    expect(markdown.indexOf("FIGURE-1")).toBeLessThan(markdown.indexOf("FIGURE-2"));
  });
});
