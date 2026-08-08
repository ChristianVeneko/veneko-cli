import { writeFile } from "fs/promises";
import { extname } from "path";
import { completeText } from "../ai/text.js";
import { transcribeImage } from "../ai/vision.js";
import { extractMarkdown, type MarkitdownCommand } from "./markitdown.js";
import { findPdfFigures, type PdfFigure } from "./pdf-figures.js";
import {
  appendFigureSection,
  figureId,
  insertFigurePlaceholders,
  substituteFigureBlocks,
  FIGURE_PLACEHOLDER_RULE,
  type FigureBlock,
  type FigureId,
} from "./figure-placement.js";
import type { ProviderId } from "../config/providers.js";

export const DEFAULT_FORMATTING_PROMPT = `You are cleaning up Markdown that was mechanically extracted from a document. The extraction is faithful but ugly: broken line wrapping, lost heading levels, mangled tables and lists, stray page numbers and repeated headers or footers.

Rewrite it as clean, readable Markdown:
- Join lines that a converter split mid-sentence, and keep real paragraph breaks.
- Restore heading levels with #, ##, ### based on the document's structure.
- Rebuild lists and tables in proper Markdown syntax.
- Preserve bold, italics, links, code and footnotes.
- Remove page numbers and headers or footers that repeat on every page.

Hard rules:
- Never invent, summarize, translate or omit content. Every fact in the input must survive.
- Keep the original language of the text.
- Return only the Markdown. No preamble, no commentary, no code fence around the whole answer.`;

/**
 * Figures are cropped out of the PDF and sent one at a time, so the model is
 * asked to pick a representation rather than to caption an illustration. A
 * flowchart should come back as Mermaid, a circuit as a netlist, a chart as the
 * numbers behind it — the point is to carry the information into text, not to
 * say what the picture looks like.
 */
/**
 * Reply that marks a crop as not being a figure at all.
 *
 * Vector regions are found by clustering drawing operations, and a table's
 * borders cluster exactly like a diagram's boxes do. Telling them apart
 * geometrically is unreliable, so the crop is sent and the model is given a way
 * to say "this is not a figure" — a judgement it makes far better than a rule
 * about line lattices ever could.
 */
export const NOT_A_FIGURE = "NOT_A_FIGURE";

export const DEFAULT_FIGURE_PROMPT = `You are looking at one region cropped out of a document, which may or may not be a figure.

First decide whether it is one. Reply with exactly ${NOT_A_FIGURE} and nothing else if the crop is any of these:
- The ruled borders or gridlines of a data table, with no diagram in it.
- A horizontal or vertical rule, a page border, a frame, or a decorative divider.
- Underlined or highlighted body text, a header, a footer, or a page number.
- Blank space, a background tint, or a fragment too small to carry meaning.

Otherwise turn it into Markdown that carries the same information as the image, so a reader who never sees the image loses nothing.

Pick the representation that fits what you actually see:
- Flowchart, process, tree, org chart, state machine, sequence, class or entity-relationship diagram → a Mermaid diagram inside a \`\`\`mermaid fence, using the matching Mermaid type (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt). Keep every node label as written and every arrow direction and arrow label.
- Electrical, electronic, hydraulic or pneumatic circuit → first a component table with reference designators, component types and values, then a connection list naming what joins to what, node by node. Call out supply rails, ground, polarity and pin numbers when they are marked.
- Table, spreadsheet or form → a Markdown table.
- Chart or graph (bar, line, pie, scatter, histogram) → a Markdown table of the plotted series, then one line naming the axes, their units, and the trend the chart shows. Read values off the axes; approximate values are fine, invented ones are not.
- Mathematical formula, equation or chemical structure → LaTeX inside $$ delimiters, plus a line naming each symbol.
- Source code, configuration or terminal output → a fenced code block with the right language tag.
- Map, floor plan, assembly drawing or technical schematic → a description of the layout, every label and callout, dimensions, and the spatial relationships between parts.
- A whole page of scanned text → transcribe it as Markdown, keeping headings, lists and emphasis.
- Photograph, illustration, screenshot or logo → a description dense enough to stand in for the image: what it shows, every piece of visible text, and any detail a reader would need.

Hard rules:
- Transcribe every label, caption, axis title, unit, legend entry and callout exactly as written, in the original language of the document.
- Never invent a value, label or connection you cannot actually read. Write [illegible] instead.
- Do not describe the crop or the act of looking at it. No "this image shows", no "the figure depicts" — go straight to the content.
- Return only the Markdown for the figure. No preamble, no commentary, and no code fence wrapped around your whole answer.`;

export interface FigureModel {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

export interface DocumentToMarkdownOptions {
  filePath: string;
  outputPath: string;
  provider: ProviderId;
  model: string;
  apiKey: string;
  prompt?: string;
  /** Skips the AI pass and writes markitdown's raw output. */
  raw?: boolean;
  /** Reuses an already-detected markitdown entry point. */
  markitdownCommand?: MarkitdownCommand;
  /** Approximate characters per model request. */
  chunkChars?: number;
  /** How many chunks to format in parallel. */
  concurrency?: number;
  /**
   * Detect images embedded in a PDF and describe each one with a vision model.
   * Ignored for every other format, since only PDFs can be inspected this way.
   */
  figures?: boolean;
  /** Vision model for the figures. Defaults to the formatting model. */
  figureModel?: FigureModel;
  figurePrompt?: string;
  /** Ignore regions whose shorter side is under this many PDF points. */
  minFigureSizePt?: number;
  /** How many figures to describe in parallel. */
  figureConcurrency?: number;
  onStage?: (
    stage: "extracting" | "scanning-figures" | "describing-figures" | "formatting" | "writing"
  ) => void;
  onChunkDone?: (info: { completed: number; total: number }) => void;
  onFigureDone?: (info: { completed: number; total: number }) => void;
}

export interface DocumentToMarkdownResult {
  outputPath: string;
  /** Number of chunks the extracted Markdown was split into. */
  chunks: number;
  /** 1-based indices of chunks the model failed on; their raw text was kept. */
  failedChunks: number[];
  rawChars: number;
  outputChars: number;
  formatted: boolean;
  /** Figures detected in the PDF. Zero when the feature was off or n/a. */
  figuresFound: number;
  /** Figures the vision model returned content for. */
  figuresDescribed: number;
  /** Ids like "p3#1" for figures the vision model failed on. */
  failedFigures: string[];
  /**
   * Regions the model judged were not figures — table borders, rules, frames.
   * Their placeholders are removed, so they leave no trace in the output.
   */
  figuresRejected: number;
  /** Figures collected at the end because their position was not found. */
  figuresAppended: number;
  /** Regions dropped by the per-page cap, so nothing is silently lost. */
  figuresSkipped: number;
}

/**
 * Roughly 3k tokens of input. Leaves the model enough output budget to return
 * the whole chunk rewritten rather than truncated.
 */
const DEFAULT_CHUNK_CHARS = 12_000;
const DEFAULT_CONCURRENCY = 3;

/**
 * Splits Markdown into chunks of at most maxChars, breaking on blank lines so a
 * paragraph, list or table is never cut in half. A single block longer than the
 * limit is split on line boundaries as a last resort.
 */
export function splitIntoChunks(markdown: string, maxChars: number): string[] {
  const blocks = markdown
    .split(/(?:\r?\n){2,}/)
    .filter((block) => block.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const block of blocks) {
    for (const piece of splitOversizedBlock(block, maxChars)) {
      const candidate = current.length === 0 ? piece : `${current}\n\n${piece}`;

      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      flush();
      current = piece;
    }
  }

  flush();
  return chunks;
}

function splitOversizedBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];

  const pieces: string[] = [];
  let current = "";

  for (const line of block.split(/\r?\n/)) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current.length > 0) pieces.push(current);
    // A single line past the limit still has to go somewhere; the model
    // truncating it is better than dropping it.
    current = line;
  }

  if (current.length > 0) pieces.push(current);
  return pieces;
}

/**
 * Models often wrap a whole Markdown answer in a fence despite being told not
 * to. Unwrapping is safe: a fence around the entire response is never content.
 */
export function stripOuterFence(text: string): string {
  const match = text.trim().match(/^```[\w-]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : text.trim();
}

function chunkPrompt(
  basePrompt: string,
  index: number,
  total: number,
  hasFigures: boolean
): string {
  const parts = [basePrompt];

  if (hasFigures) parts.push(FIGURE_PLACEHOLDER_RULE);

  if (total > 1) {
    parts.push(
      `This is fragment ${index + 1} of ${total} from a longer document. ` +
      "Format only this fragment. Do not add an introduction or a conclusion, and " +
      "do not restate content from other fragments."
    );
  }

  return parts.join("\n\n");
}

/** Only PDFs expose their embedded images to inspection. */
function isPdf(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".pdf";
}

const DEFAULT_FIGURE_CONCURRENCY = 2;

interface DescribedFigures {
  blocks: FigureBlock[];
  described: number;
  failed: string[];
  /** Ids the model judged not to be figures at all. */
  rejected: string[];
}

/**
 * True when the model used its escape hatch to say the crop is not a figure.
 * Matched loosely because a model asked for one bare word still tends to wrap it
 * in a sentence or a full stop.
 */
export function isNotAFigure(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return false;

  // Only a short reply counts, so a real description that happens to quote the
  // sentinel is not thrown away.
  return trimmed.length <= NOT_A_FIGURE.length + 20 && trimmed.includes(NOT_A_FIGURE);
}

/**
 * Sends each cropped figure to the vision model.
 *
 * Three outcomes are kept apart on purpose. A figure the model describes becomes
 * content. A figure it rejects is dropped entirely, placeholder and all, because
 * a table's borders are not worth a line in the output. A figure the request
 * fails on keeps its placeholder and an explanatory comment, so the output still
 * records that something was there.
 */
async function describeFigures(
  figures: PdfFigure[],
  model: FigureModel,
  prompt: string,
  concurrency: number,
  onFigureDone?: (info: { completed: number; total: number }) => void
): Promise<DescribedFigures> {
  const blocks: (FigureBlock | null)[] = new Array(figures.length).fill(null);
  const failed: string[] = [];
  const rejected: string[] = [];
  let described = 0;
  let completed = 0;

  for (let index = 0; index < figures.length; index += concurrency) {
    const batch = figures.slice(index, index + concurrency);

    await Promise.all(
      batch.map(async (figure, offset) => {
        const position = index + offset;
        const id = figureId(figure);

        try {
          const answer = await transcribeImage({
            provider: model.provider,
            model: model.model,
            apiKey: model.apiKey,
            prompt,
            imageBase64: figure.imageBase64,
            mimeType: figure.mimeType,
          });

          if (isNotAFigure(answer)) {
            rejected.push(id);
            return;
          }

          const content = cleanFigureAnswer(answer);

          if (content.length > 0) {
            blocks[position] = { page: figure.page, index: figure.index, content };
            described += 1;
          } else {
            failed.push(id);
            blocks[position] = {
              page: figure.page,
              index: figure.index,
              content: `<!-- veneko: figure ${id} returned nothing -->`,
            };
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message.replace(/\s+/g, " ") : String(err);
          failed.push(id);
          blocks[position] = {
            page: figure.page,
            index: figure.index,
            content: `<!-- veneko: figure ${id} failed — ${reason} -->`,
          };
        } finally {
          completed += 1;
          onFigureDone?.({ completed, total: figures.length });
        }
      })
    );
  }

  return {
    blocks: blocks.filter((block): block is FigureBlock => block !== null),
    described,
    failed,
    rejected,
  };
}

/**
 * stripOuterFence unwraps a fence around a whole answer, which is right for
 * prose but catastrophic for a figure whose entire content is one Mermaid or
 * code block: stripping it turns a diagram into loose text that renders as
 * nothing. A fence carrying a real language tag is the content, not packaging.
 */
export function cleanFigureAnswer(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    const firstBreak = trimmed.indexOf("\n");
    const language = (firstBreak === -1 ? "" : trimmed.slice(3, firstBreak)).trim().toLowerCase();

    if (language.length > 0 && language !== "markdown" && language !== "md") return trimmed;
  }

  return stripOuterFence(trimmed);
}

/**
 * Converts any document markitdown supports to Markdown, then runs the result
 * through a language model to make it readable.
 *
 * With `figures` on and a PDF as input, every image embedded in the document is
 * cropped out, described by a vision model, and spliced back into the text at
 * the point it appeared. Placeholders are inserted before the formatting pass
 * and resolved after it, so the formatting model decides nothing about figure
 * placement and never gets a chance to rewrite a Mermaid diagram.
 *
 * Nothing is discarded on failure: a chunk the model fails on keeps its raw
 * extracted text, a figure it fails on keeps a comment where it belongs, and a
 * figure whose position cannot be found is appended in a section of its own.
 * Losing formatting or placement is recoverable, losing content is not.
 */
export async function convertDocumentToMarkdown(
  options: DocumentToMarkdownOptions
): Promise<DocumentToMarkdownResult> {
  const {
    filePath,
    outputPath,
    provider,
    model,
    apiKey,
    prompt = DEFAULT_FORMATTING_PROMPT,
    raw = false,
    markitdownCommand,
    chunkChars = DEFAULT_CHUNK_CHARS,
    concurrency = DEFAULT_CONCURRENCY,
    figures = false,
    figureModel,
    figurePrompt = DEFAULT_FIGURE_PROMPT,
    minFigureSizePt,
    figureConcurrency = DEFAULT_FIGURE_CONCURRENCY,
    onStage,
    onChunkDone,
    onFigureDone,
  } = options;

  onStage?.("extracting");
  const extracted = await extractMarkdown(filePath, { command: markitdownCommand });

  const visionModel: FigureModel = figureModel ?? { provider, model, apiKey };
  const wantFigures = figures && isPdf(filePath) && visionModel.apiKey.length > 0;

  let body = extracted;
  let found: PdfFigure[] = [];
  let figuresSkipped = 0;
  let blocks: FigureBlock[] = [];
  let unplaced: FigureId[] = [];
  let described = 0;
  let failedFigures: string[] = [];
  let figuresRejected = 0;

  if (wantFigures) {
    onStage?.("scanning-figures");
    const scan = await findPdfFigures(filePath, { minSizePt: minFigureSizePt });
    found = scan.figures;
    figuresSkipped = scan.skipped;
  }

  if (found.length > 0) {
    const pageCount = Math.max(...found.map((figure) => figure.page));
    const inserted = insertFigurePlaceholders(
      extracted,
      found.map((figure) => ({
        page: figure.page,
        index: figure.index,
        anchorText: figure.anchorText,
        // Figures are ordered by page, so the page number is the only estimate
        // of document position available before the text is analysed.
        relativePosition: (figure.page - 0.5) / pageCount,
      }))
    );

    body = inserted.markdown;
    unplaced = inserted.unplaced;

    onStage?.("describing-figures");
    const result = await describeFigures(
      found,
      visionModel,
      figurePrompt,
      figureConcurrency,
      onFigureDone
    );
    blocks = result.blocks;
    described = result.described;
    failedFigures = result.failed;
    figuresRejected = result.rejected.length;
  }

  const chunks = raw ? [] : splitIntoChunks(body, chunkChars);
  const failedChunks: number[] = [];

  if (!raw) {
    const formatted: string[] = new Array(chunks.length).fill("");
    let completed = 0;

    onStage?.("formatting");

    for (let index = 0; index < chunks.length; index += concurrency) {
      const batch = chunks.slice(index, index + concurrency);

      await Promise.all(
        batch.map(async (chunk, offset) => {
          const position = index + offset;

          try {
            const result = await completeText({
              provider,
              model,
              apiKey,
              prompt: chunkPrompt(prompt, position, chunks.length, found.length > 0),
              input: chunk,
            });

            const cleaned = stripOuterFence(result);
            // An empty answer means the model dropped the fragment. Keep the raw
            // text rather than a hole in the document.
            formatted[position] = cleaned.length > 0 ? cleaned : chunk;
            if (cleaned.length === 0) failedChunks.push(position + 1);
          } catch {
            formatted[position] = chunk;
            failedChunks.push(position + 1);
          } finally {
            completed += 1;
            onChunkDone?.({ completed, total: chunks.length });
          }
        })
      );
    }

    body = formatted.join("\n\n").trim();
  }

  let figuresAppended = 0;

  // Guarded on the figures found, not on the blocks produced: when every region
  // is rejected there are no blocks, and the placeholders still have to be
  // stripped out rather than left behind in the text.
  if (found.length > 0) {
    const unplacedIds = new Set(unplaced.map((id) => figureId(id)));
    const inlineBlocks = blocks.filter((block) => !unplacedIds.has(figureId(block)));

    const substituted = substituteFigureBlocks(body, inlineBlocks);
    body = substituted.markdown;

    // A placeholder the formatting model dropped, plus every figure that never
    // had one, get appended so the figure survives even if its position did not.
    const orphaned = [
      ...substituted.missing,
      ...blocks.filter((block) => unplacedIds.has(figureId(block))),
    ];

    body = appendFigureSection(body, orphaned);
    figuresAppended = orphaned.length;
  }

  onStage?.("writing");
  const output = `${body.trim()}\n`;
  await writeFile(outputPath, output, "utf-8");

  return {
    outputPath,
    chunks: chunks.length,
    failedChunks: failedChunks.sort((a, b) => a - b),
    rawChars: extracted.length,
    outputChars: output.length,
    formatted: !raw,
    figuresFound: found.length,
    figuresDescribed: described,
    failedFigures,
    figuresRejected,
    figuresAppended,
    figuresSkipped,
  };
}
