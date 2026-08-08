import { writeFile } from "fs/promises";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { transcribeImage } from "../ai/vision.js";
import { openPdfDocument, renderRegionToJpeg, RENDERED_IMAGE_MIME } from "./pdf-render.js";
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
/** Every current vision model downscales past roughly this size. */
const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_JPEG_QUALITY = 85;
export const PAGE_IMAGE_MIME = RENDERED_IMAGE_MIME;

/** Renders one whole page to a base64 JPEG. */
async function renderPageToImage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  dpi: number,
  maxEdge: number,
  jpegQuality: number
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  return renderRegionToJpeg(page, { dpi, maxEdge, jpegQuality });
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

  const { doc, loadingTask } = await openPdfDocument(pdfPath);

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
