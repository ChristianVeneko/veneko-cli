import { readFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, join, sep } from "path";
import { createCanvas } from "@napi-rs/canvas";
import {
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

export const PDF_POINTS_PER_INCH = 72;
export const RENDERED_IMAGE_MIME = "image/jpeg";

/**
 * A rectangle in PDF user space: [x0, y0, x1, y1] with the origin at the
 * bottom-left of the page, the convention pdf.js reports geometry in.
 */
export type PdfRect = [number, number, number, number];

/**
 * pdf.js loads fonts, character maps, ICC profiles and its image-codec wasm
 * modules on demand. The wasm ones matter most here: scanned pages are usually
 * JBIG2 or JPEG 2000, which fail to decode without them.
 *
 * Paths are resolved from the installed package because this file is bundled
 * while pdfjs-dist stays external. pdf.js reads them through its Node
 * file-system loader, so they must be plain paths rather than file:// URLs, and
 * it validates a trailing forward slash even on Windows.
 */
export function pdfAssetPaths(): {
  standardFontDataUrl: string;
  cMapUrl: string;
  iccUrl: string;
  wasmUrl: string;
} {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const assetDir = (name: string) => `${join(packageRoot, name).split(sep).join("/")}/`;

  return {
    standardFontDataUrl: assetDir("standard_fonts"),
    cMapUrl: assetDir("cmaps"),
    iccUrl: assetDir("iccs"),
    wasmUrl: assetDir("wasm"),
  };
}

/**
 * Opens a PDF from disk. The loading task is returned alongside the document
 * because destroying it is what terminates the pdf.js worker — without that the
 * process never exits.
 */
export async function openPdfDocument(pdfPath: string): Promise<{
  doc: PDFDocumentProxy;
  loadingTask: PDFDocumentLoadingTask;
}> {
  const data = new Uint8Array(await readFile(pdfPath));
  const loadingTask = getDocument({ data, ...pdfAssetPaths(), cMapPacked: true });
  return { doc: await loadingTask.promise, loadingTask };
}

export interface RenderRegionOptions {
  /** Render resolution. Higher is sharper but costs more tokens. */
  dpi: number;
  /**
   * Upper bound on the longest side of the rendered image, in pixels. Providers
   * downscale larger images anyway, and Anthropic rejects payloads over 5 MB.
   */
  maxEdge: number;
  /** JPEG quality, 1-100. Lower means cheaper requests. */
  jpegQuality: number;
  /** Region to capture. Defaults to the whole page. */
  region?: PdfRect;
}

/**
 * Renders a page, or a rectangular region of one, to a base64 JPEG.
 *
 * The requested DPI is capped so the longest side of the result stays within
 * maxEdge — beyond that, providers downscale the image themselves, so the extra
 * pixels only cost upload size and tokens. The cap is measured against the
 * region actually being captured, so a small figure is not starved of
 * resolution by the size of the page it sits on.
 */
export async function renderRegionToJpeg(
  page: PDFPageProxy,
  options: RenderRegionOptions
): Promise<string> {
  const { dpi, maxEdge, jpegQuality, region } = options;

  const unscaled = page.getViewport({ scale: 1 });
  const regionWidthPt = region ? Math.abs(region[2] - region[0]) : unscaled.width;
  const regionHeightPt = region ? Math.abs(region[3] - region[1]) : unscaled.height;
  const longestSidePt = Math.max(regionWidthPt, regionHeightPt);

  const scale = Math.min(dpi / PDF_POINTS_PER_INCH, maxEdge / longestSidePt);
  const viewport = page.getViewport({ scale });

  let canvasWidth = Math.ceil(viewport.width);
  let canvasHeight = Math.ceil(viewport.height);
  let offsetX = 0;
  let offsetY = 0;

  if (region) {
    // The viewport flips the y axis, so the PDF-space top edge (the larger y)
    // maps to the smaller viewport y. Taking the min and max of both corners
    // keeps this correct regardless of page rotation.
    const [ax, ay] = viewport.convertToViewportPoint(region[0], region[3]);
    const [bx, by] = viewport.convertToViewportPoint(region[2], region[1]);

    offsetX = Math.min(ax, bx);
    offsetY = Math.min(ay, by);
    canvasWidth = Math.max(1, Math.ceil(Math.abs(bx - ax)));
    canvasHeight = Math.max(1, Math.ceil(Math.abs(by - ay)));
  }

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const context = canvas.getContext("2d");

  // PDF pages are transparent; without a white base, scans render as black.
  context.fillStyle = "white";
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  // Shifting the page moves the requested region onto the canvas origin, so
  // everything outside it falls off the edges and is never drawn.
  if (offsetX !== 0 || offsetY !== 0) context.translate(-offsetX, -offsetY);

  await page.render({ canvasContext: context, viewport, canvas }).promise;
  page.cleanup();

  return canvas.toBuffer(RENDERED_IMAGE_MIME, jpegQuality).toString("base64");
}
