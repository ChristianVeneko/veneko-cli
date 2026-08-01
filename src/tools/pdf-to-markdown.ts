import { readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, join, sep } from "path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { transcribeImage } from "../ai/vision.js";
import type { ProviderId } from "../config/providers.js";

export const DEFAULT_TRANSCRIPTION_PROMPT = `Transcribe this book page to pure Markdown.
- Use #, ##, ### for headings.
- Preserve bold, italics and lists.
- Use the [^1] format for footnotes.
- Do not add introductions or commentary, only the transcribed text.`;

export interface PdfToMarkdownOptions {
  pdfPath: string;
  outputPath: string;
  provider: ProviderId;
  model: string;
  apiKey: string;
  prompt?: string;
  /** Render resolution. Higher is sharper but costs more tokens. */
  dpi?: number;
  /**
   * Upper bound on the longest side of the rendered image, in pixels. Providers
   * downscale larger images anyway, and Anthropic rejects payloads over 5 MB.
   */
  maxEdge?: number;
  /** JPEG quality, 1-100. Lower means cheaper requests. */
  jpegQuality?: number;
  /** 1-based inclusive page range. Defaults to the whole document. */
  firstPage?: number;
  lastPage?: number;
  /** How many pages to transcribe in parallel. */
  concurrency?: number;
  onPageDone?: (info: { page: number; completed: number; total: number }) => void;
}

export interface PdfToMarkdownResult {
  outputPath: string;
  pagesProcessed: number;
  failedPages: number[];
}

interface PageResult {
  page: number;
  markdown: string;
  error?: string;
}

const DEFAULT_DPI = 200;
const DEFAULT_CONCURRENCY = 3;
const PDF_POINTS_PER_INCH = 72;
/** Every current vision model downscales past roughly this size. */
const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_JPEG_QUALITY = 85;
export const PAGE_IMAGE_MIME = "image/jpeg";

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
function pdfAssetPaths(): {
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
 * Renders one page to a base64 JPEG. The requested DPI is capped so the longest
 * side stays within maxEdge — beyond that, providers downscale the image
 * themselves, so the extra pixels only cost upload size and tokens.
 */
async function renderPageToImage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  dpi: number,
  maxEdge: number,
  jpegQuality: number
): Promise<string> {
  const page = await doc.getPage(pageNumber);

  const unscaled = page.getViewport({ scale: 1 });
  const longestSidePt = Math.max(unscaled.width, unscaled.height);
  const scale = Math.min(dpi / PDF_POINTS_PER_INCH, maxEdge / longestSidePt);

  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");

  // PDF pages are transparent; without a white base, scans render as black.
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: context, viewport, canvas }).promise;
  page.cleanup();

  return canvas.toBuffer(PAGE_IMAGE_MIME, jpegQuality).toString("base64");
}

function buildMarkdown(results: PageResult[]): string {
  return results
    .map((result) => {
      const body = result.error
        ? `<!-- veneko: page ${result.page} failed — ${result.error} -->`
        : result.markdown;
      return `<!-- Page ${result.page} -->\n\n${body}\n\n---\n`;
    })
    .join("\n");
}

/**
 * Rasterizes every page of a PDF and asks a vision model to transcribe it to
 * Markdown. Results are written after each batch so a failure late in a long
 * document does not discard the work already done.
 */
export async function convertPdfToMarkdown(
  options: PdfToMarkdownOptions
): Promise<PdfToMarkdownResult> {
  const {
    pdfPath,
    outputPath,
    provider,
    model,
    apiKey,
    prompt = DEFAULT_TRANSCRIPTION_PROMPT,
    dpi = DEFAULT_DPI,
    maxEdge = DEFAULT_MAX_EDGE,
    jpegQuality = DEFAULT_JPEG_QUALITY,
    concurrency = DEFAULT_CONCURRENCY,
    onPageDone,
  } = options;

  const data = new Uint8Array(await readFile(pdfPath));
  const loadingTask = getDocument({ data, ...pdfAssetPaths(), cMapPacked: true });
  const doc = await loadingTask.promise;

  const firstPage = Math.max(1, options.firstPage ?? 1);
  const lastPage = Math.min(doc.numPages, options.lastPage ?? doc.numPages);

  if (firstPage > lastPage) {
    throw new Error(
      `Invalid page range: ${firstPage}-${lastPage}. The document has ${doc.numPages} pages.`
    );
  }

  const pageNumbers: number[] = [];
  for (let page = firstPage; page <= lastPage; page += 1) {
    pageNumbers.push(page);
  }

  const results: PageResult[] = [];
  let completed = 0;

  try {
    for (let index = 0; index < pageNumbers.length; index += concurrency) {
      const batch = pageNumbers.slice(index, index + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (page): Promise<PageResult> => {
          try {
            const imageBase64 = await renderPageToImage(
              doc,
              page,
              dpi,
              maxEdge,
              jpegQuality
            );
            const markdown = await transcribeImage({
              provider,
              model,
              apiKey,
              prompt,
              imageBase64,
              mimeType: PAGE_IMAGE_MIME,
            });
            return { page, markdown };
          } catch (err) {
            return {
              page,
              markdown: "",
              error: err instanceof Error ? err.message.replace(/\s+/g, " ") : String(err),
            };
          } finally {
            completed += 1;
            onPageDone?.({ page, completed, total: pageNumbers.length });
          }
        })
      );

      results.push(...batchResults);
      await writeFile(outputPath, buildMarkdown(results), "utf-8");
    }
  } finally {
    // Terminates the pdf.js worker; without it the process would not exit.
    await loadingTask.destroy();
  }

  return {
    outputPath,
    pagesProcessed: results.filter((r) => !r.error).length,
    failedPages: results.filter((r) => r.error).map((r) => r.page),
  };
}
