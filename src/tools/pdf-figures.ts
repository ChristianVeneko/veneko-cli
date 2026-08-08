import { OPS, Util, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  openPdfDocument,
  renderRegionToJpeg,
  RENDERED_IMAGE_MIME,
  type PdfRect,
} from "./pdf-render.js";

/**
 * How a figure was found. A bitmap is almost certainly content; a cluster of
 * vector drawing might equally be a table's borders, so the caller is expected
 * to let the vision model reject those.
 */
export type FigureSource = "image" | "vector";

/** A figure found on a page, cropped and ready to send to a vision model. */
export interface PdfFigure {
  /** 1-based page number. */
  page: number;
  /** 1-based position within the page, in reading order. */
  index: number;
  /** The region captured, in PDF user space. */
  region: PdfRect;
  source: FigureSource;
  /** Base64 JPEG of the region. */
  imageBase64: string;
  mimeType: string;
  /**
   * The text that runs immediately above the figure on its page. Used to place
   * the figure back into the extracted Markdown. Empty when nothing precedes it.
   */
  anchorText: string;
}

export interface FindFiguresResult {
  figures: PdfFigure[];
  /** Regions dropped by the per-page cap, so the caller can say so. */
  skipped: number;
  pagesScanned: number;
}

export interface FindFiguresOptions {
  /** Ignore bitmap regions whose shorter side is under this many points. */
  minSizePt?: number;
  /**
   * Also cluster vector drawing into figures. Diagrams exported from Visio,
   * draw.io, TikZ or SmartArt are paths, not bitmaps, so this is the only way to
   * see them. On by default.
   */
  vectors?: boolean;
  /** Ignore vector clusters smaller than this area, in square points. */
  minVectorArea?: number;
  /** Ignore vector clusters built from fewer than this many painted paths. */
  minVectorPaths?: number;
  /** Merge regions separated by less than this many points. */
  mergeGapPt?: number;
  /** Keep at most this many figures per page, largest first. */
  maxPerPage?: number;
  /** 1-based inclusive page range. Defaults to the whole document. */
  firstPage?: number;
  lastPage?: number;
  dpi?: number;
  /** Floor on the longest side of a crop, so small figures stay legible. */
  minEdge?: number;
  maxEdge?: number;
  jpegQuality?: number;
  onPageScanned?: (info: { page: number; total: number; found: number }) => void;
}

/**
 * A quarter of an inch. Below this a region is a bullet, a rule, a logo or a
 * spacer — never a figure worth a model request.
 */
const DEFAULT_MIN_SIZE_PT = 40;
/**
 * Illustrator, Inkscape and most scanners slice one picture into adjacent
 * strips or tiles. Regions closer than this are treated as one figure.
 */
const DEFAULT_MERGE_GAP_PT = 12;
const DEFAULT_MAX_PER_PAGE = 12;
/**
 * Vector clusters are sized by area rather than by their shorter side: a wide,
 * flat figure like a timeline is legitimate, while a table rule or a text
 * underline spans just as far but encloses almost nothing.
 */
const DEFAULT_MIN_VECTOR_AREA = 2_500;
/** A rule or an underline is one painted path. A diagram is several. */
const DEFAULT_MIN_VECTOR_PATHS = 3;
const DEFAULT_DPI = 220;
const DEFAULT_MIN_EDGE = 700;
const DEFAULT_MAX_EDGE = 1400;
const DEFAULT_JPEG_QUALITY = 85;

/** How much preceding text to keep as the placement anchor. */
const ANCHOR_CHARS = 90;

/**
 * A region covering essentially the whole page, on a page that also has real
 * extracted text, is a background, a border or a watermark rather than a
 * figure. Both conditions must hold — a full-page scan has no text layer and
 * must still be captured.
 */
const BACKGROUND_AREA_RATIO = 0.98;
const BACKGROUND_TEXT_CHARS = 200;

/** Ops that paint a bitmap. Each fills the unit square, mapped by the CTM. */
const IMAGE_OPS = new Set(
  [
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintInlineImageXObjectGroup,
    // paintSolidColorImageMask is deliberately absent: it fills a stencil with
    // a flat colour, which is shading, not content.
  ].filter((op): op is number => typeof op === "number")
);

/**
 * Paint operations that actually lay down ink. pdf.js reports every path
 * through a single `constructPath` op whose first argument says what to do with
 * it, and a clipping path arrives the same way carrying `endPath` instead.
 *
 * Filtering on this set is not optional: a clip is usually set to the whole
 * page, so counting one as drawing invents a figure the size of the sheet.
 */
const INK_OPS = new Set(
  [
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ].filter((op): op is number => typeof op === "number")
);

function unionRect(a: PdfRect, b: PdfRect): PdfRect {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function rectWidth(rect: PdfRect): number {
  return rect[2] - rect[0];
}

function rectHeight(rect: PdfRect): number {
  return rect[3] - rect[1];
}

function rectArea(rect: PdfRect): number {
  return Math.max(0, rectWidth(rect)) * Math.max(0, rectHeight(rect));
}

/** True when the rectangles touch, overlap, or sit within gap points. */
function isNear(a: PdfRect, b: PdfRect, gap: number): boolean {
  const horizontalGap = Math.max(a[0] - b[2], b[0] - a[2]);
  const verticalGap = Math.max(a[1] - b[3], b[1] - a[3]);
  return horizontalGap <= gap && verticalGap <= gap;
}

/**
 * A candidate region plus a tally of what drew it. The counts are what let a
 * bitmap figure and a cluster of vector paths be filtered by different rules
 * after they have been merged together.
 */
export interface MarkedRegion {
  rect: PdfRect;
  /** Bitmap paint operations inside the region. */
  images: number;
  /** Ink-laying path operations inside the region. */
  paths: number;
}

/**
 * Collapses regions that overlap or nearly touch into single figures, summing
 * their tallies. Runs to a fixed point because merging two regions can bring a
 * third within range.
 */
export function mergeMarkedRegions(regions: MarkedRegion[], gapPt: number): MarkedRegion[] {
  const merged = regions.map((region) => ({ ...region, rect: [...region.rect] as PdfRect }));
  let changed = true;

  while (changed) {
    changed = false;

    for (let i = 0; i < merged.length && !changed; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (!isNear(merged[i].rect, merged[j].rect, gapPt)) continue;

        merged[i] = {
          rect: unionRect(merged[i].rect, merged[j].rect),
          images: merged[i].images + merged[j].images,
          paths: merged[i].paths + merged[j].paths,
        };
        merged.splice(j, 1);
        changed = true;
        break;
      }
    }
  }

  return merged;
}

/** Merges plain rectangles, ignoring what drew them. */
export function mergeFigureRegions(regions: PdfRect[], gapPt: number): PdfRect[] {
  return mergeMarkedRegions(
    regions.map((rect) => ({ rect, images: 0, paths: 0 })),
    gapPt
  ).map((region) => region.rect);
}

/**
 * Orders regions the way a reader meets them: top of the page first, then left
 * to right for figures sharing a row. PDF space puts the origin at the bottom,
 * so a larger y means higher on the page.
 */
function compareReadingOrder(a: PdfRect, b: PdfRect, rowTolerancePt: number): number {
  const sameRow = Math.abs(b[3] - a[3]) <= rowTolerancePt;
  return sameRow ? a[0] - b[0] : b[3] - a[3];
}

export function sortReadingOrder(regions: PdfRect[], rowTolerancePt = 24): PdfRect[] {
  return [...regions].sort((a, b) => compareReadingOrder(a, b, rowTolerancePt));
}

export function sortMarkedReadingOrder(
  regions: MarkedRegion[],
  rowTolerancePt = 24
): MarkedRegion[] {
  return [...regions].sort((a, b) => compareReadingOrder(a.rect, b.rect, rowTolerancePt));
}

/**
 * Reads a transformation matrix out of an operator argument.
 *
 * pdf.js hands these over inconsistently: a `transform` op carries a plain
 * array, while a form XObject's matrix arrives as a typed array. An
 * Array.isArray check passes the first and silently rejects the second, which
 * puts every figure inside a form XObject at its untransformed position.
 */
function asMatrix(value: unknown): number[] | null {
  if (value === null || typeof value !== "object") return null;

  const arrayLike = value as ArrayLike<number>;
  if (typeof arrayLike.length !== "number" || arrayLike.length < 6) return null;

  const matrix = Array.from(arrayLike, Number).slice(0, 6);
  return matrix.every((entry) => Number.isFinite(entry)) ? matrix : null;
}

/** Maps an axis-aligned rectangle through the CTM, which may rotate it. */
function transformRect(rect: PdfRect, ctm: number[]): PdfRect {
  const corners = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ];
  // applyTransform mutates the point in place and returns nothing.
  for (const corner of corners) Util.applyTransform(corner, ctm);

  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Reads the bounding box pdf.js precomputes for a constructed path. */
function pathBounds(args: unknown): PdfRect | null {
  const bounds = (args as ArrayLike<unknown> | null)?.[2];
  if (bounds === null || typeof bounds !== "object") return null;

  const arrayLike = bounds as ArrayLike<number>;
  if (typeof arrayLike.length !== "number" || arrayLike.length < 4) return null;

  const values = Array.from(arrayLike, Number).slice(0, 4);
  if (!values.every((value) => Number.isFinite(value))) return null;

  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3]),
  ];
}

/**
 * Walks a page's operator list and returns a region for every bitmap and, when
 * asked, for every path that lays down ink.
 */
export async function findPageRegions(
  page: PDFPageProxy,
  includeVectors = true
): Promise<MarkedRegion[]> {
  const opList = await page.getOperatorList();
  const regions: MarkedRegion[] = [];

  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];

  const push = () => stack.push([...ctm]);
  const pop = () => {
    ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
  };

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown;

    if (fn === OPS.save) {
      push();
      continue;
    }
    if (fn === OPS.restore) {
      pop();
      continue;
    }
    if (fn === OPS.transform) {
      const matrix = asMatrix(args);
      if (matrix) ctm = Util.transform(ctm, matrix);
      continue;
    }
    // A form XObject carries its own matrix and behaves like a save/transform
    // pair. Figures are routinely placed through one, so missing this puts
    // their bounding boxes in the wrong place.
    if (fn === OPS.paintFormXObjectBegin) {
      push();
      const matrix = asMatrix((args as ArrayLike<unknown> | null)?.[0]);
      if (matrix) ctm = Util.transform(ctm, matrix);
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) {
      pop();
      continue;
    }
    // Transparency groups save and restore state around their contents.
    if (fn === OPS.beginGroup) {
      push();
      continue;
    }
    if (fn === OPS.endGroup) {
      pop();
      continue;
    }

    if (IMAGE_OPS.has(fn)) {
      // A bitmap occupies the unit square in its own space.
      regions.push({ rect: transformRect([0, 0, 1, 1], ctm), images: 1, paths: 0 });
      continue;
    }

    if (!includeVectors || fn !== OPS.constructPath) continue;

    // Only paths that paint count. A clipping path arrives through the same op
    // carrying endPath, and is typically set to the whole page.
    const paintOp = (args as ArrayLike<unknown> | null)?.[0];
    if (typeof paintOp !== "number" || !INK_OPS.has(paintOp)) continue;

    const bounds = pathBounds(args);
    if (bounds) regions.push({ rect: transformRect(bounds, ctm), images: 0, paths: 1 });
  }

  return regions;
}

export interface TextLine {
  /** Baseline y in PDF space. Larger is higher on the page. */
  y: number;
  text: string;
}

/** Groups a page's text items into lines, ordered top to bottom. */
export async function pageTextLines(page: PDFPageProxy, tolerancePt = 3): Promise<TextLine[]> {
  const content = await page.getTextContent();
  const items: { x: number; y: number; text: string }[] = [];

  for (const item of content.items) {
    const textItem = item as { str?: string; transform?: number[] };
    if (!textItem.str || textItem.str.trim().length === 0) continue;
    if (!Array.isArray(textItem.transform) || textItem.transform.length < 6) continue;

    items.push({ x: textItem.transform[4], y: textItem.transform[5], text: textItem.str });
  }

  const lines: { y: number; parts: { x: number; text: string }[] }[] = [];

  for (const item of items) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerancePt);
    if (line) {
      line.parts.push({ x: item.x, text: item.text });
      continue;
    }
    lines.push({ y: item.y, parts: [{ x: item.x, text: item.text }] });
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => ({
      y: line.y,
      text: line.parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((line) => line.text.length > 0);
}

/** The text written above a region on its own page, in reading order. */
export function textAboveRegion(region: PdfRect, lines: TextLine[]): string {
  return lines
    .filter((line) => line.y >= region[3])
    .map((line) => line.text)
    .join(" ")
    .trim();
}

/** Keeps the last `chars` characters, which is the part nearest the figure. */
export function tailOf(text: string, chars = ANCHOR_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= chars ? trimmed : trimmed.slice(-chars);
}

/**
 * Builds the placement anchor for a region: the tail of everything written
 * before it in the document, not just on its own page. A figure that opens a
 * page has no text above it there, but it still follows the previous page's
 * last paragraph — anchoring on that keeps it in the right place instead of
 * falling through to the appended fallback section.
 *
 * A longer anchor is far less ambiguous than a single short line, which may
 * repeat across a document.
 */
export function anchorForRegion(
  region: PdfRect,
  lines: TextLine[],
  precedingTail = ""
): string {
  return tailOf(`${precedingTail} ${textAboveRegion(region, lines)}`);
}

/**
 * Finds every figure in a PDF, crops each one to a JPEG, and records the text
 * that precedes it so it can be spliced back into extracted Markdown.
 *
 * Regions are merged before filtering because exporters slice one picture into
 * many strips; filtering first would throw away every strip as too small.
 */
export async function findPdfFigures(
  pdfPath: string,
  options: FindFiguresOptions = {}
): Promise<FindFiguresResult> {
  const {
    minSizePt = DEFAULT_MIN_SIZE_PT,
    vectors = true,
    minVectorArea = DEFAULT_MIN_VECTOR_AREA,
    minVectorPaths = DEFAULT_MIN_VECTOR_PATHS,
    mergeGapPt = DEFAULT_MERGE_GAP_PT,
    maxPerPage = DEFAULT_MAX_PER_PAGE,
    dpi = DEFAULT_DPI,
    minEdge = DEFAULT_MIN_EDGE,
    maxEdge = DEFAULT_MAX_EDGE,
    jpegQuality = DEFAULT_JPEG_QUALITY,
    onPageScanned,
  } = options;

  const { doc, loadingTask } = await openPdfDocument(pdfPath);
  const figures: PdfFigure[] = [];
  let skipped = 0;
  let pagesScanned = 0;

  const firstPage = Math.max(1, options.firstPage ?? 1);
  const lastPage = Math.min(doc.numPages, options.lastPage ?? doc.numPages);

  /** Tail of the text from every page already scanned, for cross-page anchors. */
  let precedingTail = "";

  try {
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
      let found = 0;

      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const pageArea = viewport.width * viewport.height;

        const lines = await pageTextLines(page);
        const pageTextLength = lines.reduce((total, line) => total + line.text.length, 0);

        const raw = await findPageRegions(page, vectors);
        let regions = mergeMarkedRegions(raw, mergeGapPt).filter((region) => {
          // A region covering the whole page, on a page that also has real
          // text, is a background, a border or a watermark either way.
          const coversPage = rectArea(region.rect) >= pageArea * BACKGROUND_AREA_RATIO;
          if (coversPage && pageTextLength > BACKGROUND_TEXT_CHARS) return false;

          if (region.images > 0) {
            return Math.min(rectWidth(region.rect), rectHeight(region.rect)) >= minSizePt;
          }

          // Vector clusters are judged on area and on how many separate paths
          // built them, because a table rule and a diagram span the page alike.
          return rectArea(region.rect) >= minVectorArea && region.paths >= minVectorPaths;
        });

        if (regions.length > maxPerPage) {
          // Keep the largest, since area tracks how much information a figure
          // is likely to carry.
          const kept = [...regions]
            .sort((a, b) => rectArea(b.rect) - rectArea(a.rect))
            .slice(0, maxPerPage);
          skipped += regions.length - kept.length;
          regions = kept;
        }

        regions = sortMarkedReadingOrder(regions);
        found = regions.length;

        for (const [offset, region] of regions.entries()) {
          const rect = region.rect;
          const imageBase64 = await renderRegionToJpeg(page, {
            region: rect,
            dpi: Math.max(dpi, (minEdge * 72) / Math.max(rectWidth(rect), rectHeight(rect))),
            maxEdge,
            jpegQuality,
          });

          figures.push({
            page: pageNumber,
            index: offset + 1,
            region: rect,
            source: region.images > 0 ? "image" : "vector",
            imageBase64,
            mimeType: RENDERED_IMAGE_MIME,
            anchorText: anchorForRegion(rect, lines, precedingTail),
          });
        }

        precedingTail = tailOf(
          `${precedingTail} ${lines.map((line) => line.text).join(" ")}`,
          ANCHOR_CHARS * 2
        );
      } catch {
        // A page pdf.js cannot parse must not sink the whole document.
        found = 0;
      }

      pagesScanned += 1;
      onPageScanned?.({ page: pageNumber, total: lastPage - firstPage + 1, found });
    }
  } finally {
    // Terminates the pdf.js worker; without it the process would not exit.
    await loadingTask.destroy();
  }

  return { figures, skipped, pagesScanned };
}
