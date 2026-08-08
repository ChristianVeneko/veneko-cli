import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  anchorForRegion,
  findPdfFigures,
  mergeFigureRegions,
  sortReadingOrder,
  tailOf,
  textAboveRegion,
} from "../src/tools/pdf-figures.js";
import { buildFigurePdf } from "./helpers/figure-pdf.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "veneko-figures-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writePdf(name: string, buffer: Buffer): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, buffer);
  return path;
}

describe("mergeFigureRegions", () => {
  it("merges regions that overlap", () => {
    const merged = mergeFigureRegions(
      [
        [0, 0, 100, 100],
        [50, 50, 150, 150],
      ],
      0
    );

    expect(merged).toEqual([[0, 0, 150, 150]]);
  });

  it("merges strips separated by less than the gap", () => {
    // An exporter slicing one picture into three stacked bands.
    const merged = mergeFigureRegions(
      [
        [10, 100, 210, 140],
        [10, 60, 210, 99],
        [10, 20, 210, 59],
      ],
      5
    );

    expect(merged).toEqual([[10, 20, 210, 140]]);
  });

  it("leaves regions further apart than the gap alone", () => {
    const merged = mergeFigureRegions(
      [
        [0, 0, 50, 50],
        [200, 200, 250, 250],
      ],
      10
    );

    expect(merged).toHaveLength(2);
  });

  it("chains a merge that brings a third region into range", () => {
    // A and C are 60 apart, so only merging A with B pulls C in.
    const merged = mergeFigureRegions(
      [
        [0, 0, 20, 20],
        [25, 0, 45, 20],
        [50, 0, 70, 20],
      ],
      6
    );

    expect(merged).toEqual([[0, 0, 70, 20]]);
  });

  it("returns an empty list unchanged", () => {
    expect(mergeFigureRegions([], 10)).toEqual([]);
  });
});

describe("sortReadingOrder", () => {
  it("puts higher regions first, since PDF y grows upward", () => {
    const sorted = sortReadingOrder([
      [0, 100, 50, 150],
      [0, 400, 50, 450],
    ]);

    expect(sorted[0][3]).toBe(450);
  });

  it("orders left to right within a row", () => {
    const sorted = sortReadingOrder([
      [200, 400, 250, 450],
      [10, 400, 60, 450],
    ]);

    expect(sorted.map((region) => region[0])).toEqual([10, 200]);
  });
});

describe("textAboveRegion and anchorForRegion", () => {
  const lines = [
    { y: 500, text: "First paragraph of the section" },
    { y: 470, text: "Second paragraph right before the figure" },
    { y: 200, text: "Text that comes after the figure" },
  ];

  it("keeps only the lines above the region", () => {
    const above = textAboveRegion([40, 300, 240, 450], lines);

    expect(above).toBe("First paragraph of the section Second paragraph right before the figure");
    expect(above).not.toContain("after the figure");
  });

  it("anchors on the tail of the preceding text", () => {
    const anchor = anchorForRegion([40, 300, 240, 450], lines);

    expect(anchor.endsWith("right before the figure")).toBe(true);
    expect(anchor.length).toBeLessThanOrEqual(90);
  });

  it("falls back to earlier pages when nothing precedes it on this one", () => {
    // A figure at the very top of a page has no text above it there.
    const anchor = anchorForRegion([40, 500, 240, 580], [], "the last words of the previous page");

    expect(anchor).toBe("the last words of the previous page");
  });

  it("keeps the end of the text, not the start", () => {
    expect(tailOf("abcdefghij", 4)).toBe("ghij");
  });
});

describe("findPdfFigures", () => {
  it("finds an embedded image and reports its bounding box in PDF space", async () => {
    const path = await writePdf(
      "one.pdf",
      buildFigurePdf([
        {
          text: [{ y: 550, content: "Heading above the figure" }],
          images: [{ x: 40, y: 300, width: 200, height: 150 }],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    expect(figures[0].page).toBe(1);
    expect(figures[0].index).toBe(1);
    expect(figures[0].region).toEqual([40, 300, 240, 450]);
  });

  it("renders each figure as a JPEG of just that region", async () => {
    const path = await writePdf(
      "crop.pdf",
      buildFigurePdf([{ images: [{ x: 40, y: 300, width: 200, height: 150 }] }])
    );

    const { figures } = await findPdfFigures(path);
    const jpeg = Buffer.from(figures[0].imageBase64, "base64");

    expect(figures[0].mimeType).toBe("image/jpeg");
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("anchors a figure on the text printed above it", async () => {
    const path = await writePdf(
      "anchored.pdf",
      buildFigurePdf([
        {
          text: [
            { y: 560, content: "Chapter one opens with a long sentence of prose" },
            { y: 500, content: "and then introduces the diagram that follows" },
            { y: 200, content: "The text after the diagram continues here" },
          ],
          images: [{ x: 40, y: 260, width: 200, height: 150 }],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures[0].anchorText).toContain("introduces the diagram that follows");
    expect(figures[0].anchorText).not.toContain("after the diagram");
  });

  it("ignores regions smaller than the minimum size", async () => {
    const path = await writePdf(
      "tiny.pdf",
      buildFigurePdf([
        {
          images: [
            { x: 40, y: 500, width: 8, height: 8 },
            { x: 40, y: 200, width: 200, height: 150 },
          ],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    expect(figures[0].region).toEqual([40, 200, 240, 350]);
  });

  it("merges tiled strips into one figure instead of many", async () => {
    const path = await writePdf(
      "tiled.pdf",
      buildFigurePdf([
        {
          images: [
            { x: 40, y: 400, width: 200, height: 50 },
            { x: 40, y: 350, width: 200, height: 50 },
            { x: 40, y: 300, width: 200, height: 50 },
          ],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    expect(figures[0].region).toEqual([40, 300, 240, 450]);
  });

  it("follows the matrix of a form XObject when locating an image", async () => {
    const path = await writePdf(
      "form.pdf",
      buildFigurePdf([
        {
          formImages: [
            { translate: [100, 50], box: { x: 40, y: 300, width: 120, height: 120 } },
          ],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    // The form's [1 0 0 1 100 50] matrix shifts the image right and up.
    expect(figures[0].region).toEqual([140, 350, 260, 470]);
  });

  it("numbers figures per page in reading order", async () => {
    const path = await writePdf(
      "many.pdf",
      buildFigurePdf([
        {
          images: [
            { x: 40, y: 100, width: 120, height: 100 },
            { x: 40, y: 400, width: 120, height: 100 },
          ],
        },
        { images: [{ x: 40, y: 300, width: 120, height: 100 }] },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures.map((figure) => [figure.page, figure.index])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    // Page 1's first figure is the higher one on the page.
    expect(figures[0].region[1]).toBe(400);
  });

  it("keeps a full-page image when the page has no text layer", async () => {
    const path = await writePdf(
      "scan.pdf",
      buildFigurePdf([{ images: [{ x: 0, y: 0, width: 400, height: 600 }] }])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
  });

  it("drops a full-page image on a page that already has real text", async () => {
    const longText = "This page has a genuine text layer and a background image behind it. ";
    const path = await writePdf(
      "watermark.pdf",
      buildFigurePdf([
        {
          text: Array.from({ length: 6 }, (_, index) => ({
            y: 560 - index * 30,
            content: longText,
          })),
          images: [{ x: 0, y: 0, width: 400, height: 600 }],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toEqual([]);
  });

  it("honours the per-page cap and reports what it dropped", async () => {
    const path = await writePdf(
      "crowded.pdf",
      buildFigurePdf([
        {
          images: [
            { x: 20, y: 500, width: 60, height: 60 },
            { x: 150, y: 500, width: 60, height: 60 },
            { x: 280, y: 500, width: 100, height: 100 },
          ],
        },
      ])
    );

    const { figures, skipped } = await findPdfFigures(path, { maxPerPage: 1 });

    expect(figures).toHaveLength(1);
    expect(skipped).toBe(2);
    // The largest region survives the cap.
    expect(figures[0].region).toEqual([280, 500, 380, 600]);
  });

  it("honours a page range", async () => {
    const path = await writePdf(
      "ranged.pdf",
      buildFigurePdf([
        { images: [{ x: 40, y: 300, width: 120, height: 100 }] },
        { images: [{ x: 40, y: 300, width: 120, height: 100 }] },
        { images: [{ x: 40, y: 300, width: 120, height: 100 }] },
      ])
    );

    const { figures, pagesScanned } = await findPdfFigures(path, { firstPage: 2, lastPage: 3 });

    expect(pagesScanned).toBe(2);
    expect(figures.map((figure) => figure.page)).toEqual([2, 3]);
  });

  it("reports no figures for a PDF that has none", async () => {
    const path = await writePdf(
      "textonly.pdf",
      buildFigurePdf([{ text: [{ y: 500, content: "Just words on a page" }] }])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toEqual([]);
  });

  it("labels a bitmap figure as coming from an image", async () => {
    const path = await writePdf(
      "src.pdf",
      buildFigurePdf([{ images: [{ x: 40, y: 300, width: 200, height: 150 }] }])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures[0].source).toBe("image");
  });
});

describe("findPdfFigures with vector drawing", () => {
  /** Two boxes joined by an arrow: the shape of an exported flowchart. */
  const flowchart = {
    strokedBoxes: [
      { x: 60, y: 380, width: 120, height: 60 },
      { x: 60, y: 260, width: 120, height: 60 },
    ],
    lines: [{ from: [120, 380] as [number, number], to: [120, 320] as [number, number] }],
  };

  it("finds a vector flowchart that carries no embedded image", async () => {
    const path = await writePdf("vector.pdf", buildFigurePdf([flowchart]));

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    expect(figures[0].source).toBe("vector");
    // The cluster spans both boxes and the arrow between them.
    expect(figures[0].region).toEqual([60, 260, 180, 440]);
  });

  it("renders the vector cluster to a JPEG like any other figure", async () => {
    const path = await writePdf("vecrender.pdf", buildFigurePdf([flowchart]));

    const { figures } = await findPdfFigures(path);
    const jpeg = Buffer.from(figures[0].imageBase64, "base64");

    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("ignores a lone horizontal rule", async () => {
    const path = await writePdf(
      "rule.pdf",
      buildFigurePdf([
        {
          text: [{ y: 500, content: "A heading with a rule under it" }],
          lines: [{ from: [40, 480], to: [360, 480] }],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toEqual([]);
  });

  it("ignores a text underline, which encloses almost no area", async () => {
    const path = await writePdf(
      "underline.pdf",
      buildFigurePdf([
        {
          text: [{ y: 500, content: "Some underlined words here" }],
          lines: [
            { from: [40, 496], to: [200, 496] },
            { from: [40, 470], to: [200, 470] },
            { from: [40, 444], to: [200, 444] },
          ],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toEqual([]);
  });

  it("never treats a clipping path as drawing, even across the whole page", async () => {
    // A clip set to the full sheet would otherwise invent a page-sized figure.
    const path = await writePdf(
      "clip.pdf",
      buildFigurePdf([{ clipTo: { x: 0, y: 0, width: 400, height: 600 } }])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toEqual([]);
  });

  it("does not let a clip inflate a real figure's bounds", async () => {
    const path = await writePdf(
      "clipped.pdf",
      buildFigurePdf([{ clipTo: { x: 0, y: 0, width: 400, height: 600 }, ...flowchart }])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    expect(figures[0].region).toEqual([60, 260, 180, 440]);
  });

  it("leaves vector drawing alone when the option is off", async () => {
    const path = await writePdf("novec.pdf", buildFigurePdf([flowchart]));

    const { figures } = await findPdfFigures(path, { vectors: false });

    expect(figures).toEqual([]);
  });

  it("keeps a bitmap and a separate vector diagram as two figures", async () => {
    const path = await writePdf(
      "mixed.pdf",
      buildFigurePdf([
        {
          images: [{ x: 40, y: 60, width: 160, height: 120 }],
          strokedBoxes: [
            { x: 60, y: 480, width: 100, height: 60 },
            { x: 200, y: 480, width: 100, height: 60 },
          ],
          lines: [{ from: [160, 510], to: [200, 510] }],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(2);
    // Reading order puts the vector diagram, higher on the page, first.
    expect(figures.map((figure) => figure.source)).toEqual(["vector", "image"]);
  });

  it("merges vector drawing that overlaps a bitmap into one image figure", async () => {
    // A chart with a raster background and vector axes drawn on top.
    const path = await writePdf(
      "overlay.pdf",
      buildFigurePdf([
        {
          images: [{ x: 60, y: 300, width: 200, height: 150 }],
          lines: [
            { from: [60, 300], to: [260, 300] },
            { from: [60, 300], to: [60, 450] },
            { from: [60, 380], to: [260, 380] },
          ],
        },
      ])
    );

    const { figures } = await findPdfFigures(path);

    expect(figures).toHaveLength(1);
    expect(figures[0].source).toBe("image");
  });

  it("honours a raised path-count threshold", async () => {
    const path = await writePdf("threshold.pdf", buildFigurePdf([flowchart]));

    // The flowchart is three painted paths, so a floor of four excludes it.
    const { figures } = await findPdfFigures(path, { minVectorPaths: 4 });

    expect(figures).toEqual([]);
  });
});
