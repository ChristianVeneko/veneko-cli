import { writeFile } from "fs/promises";
import { completeText } from "../ai/text.js";
import { extractMarkdown, type MarkitdownCommand } from "./markitdown.js";
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
  onStage?: (stage: "extracting" | "formatting" | "writing") => void;
  onChunkDone?: (info: { completed: number; total: number }) => void;
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

function chunkPrompt(basePrompt: string, index: number, total: number): string {
  if (total === 1) return basePrompt;

  return (
    `${basePrompt}\n\n` +
    `This is fragment ${index + 1} of ${total} from a longer document. ` +
    "Format only this fragment. Do not add an introduction or a conclusion, and " +
    "do not restate content from other fragments."
  );
}

/**
 * Converts any document markitdown supports to Markdown, then runs the result
 * through a language model to make it readable.
 *
 * A chunk the model fails on keeps its raw extracted text — losing formatting
 * is recoverable, losing the content is not.
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
    onStage,
    onChunkDone,
  } = options;

  onStage?.("extracting");
  const extracted = await extractMarkdown(filePath, { command: markitdownCommand });

  if (raw) {
    onStage?.("writing");
    await writeFile(outputPath, `${extracted}\n`, "utf-8");
    return {
      outputPath,
      chunks: 0,
      failedChunks: [],
      rawChars: extracted.length,
      outputChars: extracted.length,
      formatted: false,
    };
  }

  const chunks = splitIntoChunks(extracted, chunkChars);
  const formatted: string[] = new Array(chunks.length).fill("");
  const failedChunks: number[] = [];
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
            prompt: chunkPrompt(prompt, position, chunks.length),
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

  onStage?.("writing");
  const output = `${formatted.join("\n\n").trim()}\n`;
  await writeFile(outputPath, output, "utf-8");

  return {
    outputPath,
    chunks: chunks.length,
    failedChunks: failedChunks.sort((a, b) => a - b),
    rawChars: extracted.length,
    outputChars: output.length,
    formatted: true,
  };
}
