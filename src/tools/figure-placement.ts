/**
 * Figures are spliced into the extracted Markdown as HTML-comment placeholders
 * before the AI formatting pass, and the real content is substituted back in
 * afterwards.
 *
 * Doing it in that order matters twice over: the formatting model decides
 * nothing about where a figure belongs, and it never sees the figure's Markdown,
 * so a Mermaid diagram or a LaTeX block reaches the file exactly as the vision
 * model wrote it.
 */

/** Identifies a figure by page and position within that page. */
export interface FigureId {
  page: number;
  index: number;
}

export interface FigurePlacement extends FigureId {
  /** Text that runs immediately before the figure in the source document. */
  anchorText: string;
  /** Where the figure falls in the document, 0 to 1. Breaks anchor ties. */
  relativePosition: number;
}

export interface FigureBlock extends FigureId {
  /** Markdown for the figure. */
  content: string;
}

export interface InsertPlaceholdersResult {
  markdown: string;
  /** Figures spliced inline, in document order. */
  placed: FigureId[];
  /** Figures with no usable anchor. The caller appends these instead. */
  unplaced: FigureId[];
}

export interface SubstituteResult {
  markdown: string;
  /** Figures whose placeholder was gone by substitution time. */
  missing: FigureBlock[];
}

/**
 * An anchor shorter than this matches too much to trust. "Figure 1" appears on
 * twenty pages; ninety characters of running prose appears once.
 */
const MIN_ANCHOR_CHARS = 15;

const PLACEHOLDER_PATTERN = /<!--\s*veneko:figure\s+p(\d+)#(\d+)\s*-->/g;

export function figureId(id: FigureId): string {
  return `p${id.page}#${id.index}`;
}

export function figurePlaceholder(id: FigureId): string {
  return `<!-- veneko:figure ${figureId(id)} -->`;
}

/** Instruction appended to the formatting prompt when figures are in play. */
export const FIGURE_PLACEHOLDER_RULE =
  "The text contains HTML comments of the form <!-- veneko:figure p1#1 -->. " +
  "Reproduce every one of them verbatim, exactly where it appears in the input, " +
  "on its own line. They mark where a figure belongs. Never move, merge, " +
  "renumber, describe or drop them.";

interface NormalizedText {
  normalized: string;
  /** offsets[i] is the index in the source string that normalized[i] came from. */
  offsets: number[];
}

/**
 * Strips a character down to a comparable form: accents removed, lowercased.
 * Folding through NFD means a precomposed "ó" and an "o" followed by a
 * combining acute both reduce to "o", so text from pdf.js and text from
 * markitdown compare equal even when they disagree on Unicode normalization.
 */
function foldChar(ch: string): string {
  return ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Reduces text to lowercase letters and digits separated by single spaces,
 * recording where each surviving character came from. The offset map is what
 * lets a match in the normalized text turn back into a position in the original
 * Markdown, so the placeholder lands in real text rather than in a stripped
 * copy of it.
 */
function normalizeWithMap(text: string): NormalizedText {
  let normalized = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  let offset = 0;

  for (const ch of text) {
    const folded = foldChar(ch);
    const kept = [...folded].filter(isWordChar);

    if (kept.length === 0) {
      // A combining mark folds away to nothing, but it belongs to the letter
      // before it — treating it as a separator would turn a decomposed
      // "sección" into "seccio n" and stop it matching the precomposed form.
      if (!/\p{M}/u.test(ch)) pendingSpace = true;
      offset += ch.length;
      continue;
    }

    if (pendingSpace && normalized.length > 0) {
      normalized += " ";
      offsets.push(offset);
    }
    pendingSpace = false;

    for (const wordChar of kept) {
      normalized += wordChar;
      offsets.push(offset);
    }

    offset += ch.length;
  }

  return { normalized, offsets };
}

function normalizeAnchor(anchor: string): string {
  return normalizeWithMap(anchor).normalized;
}

/**
 * Picks the occurrence of the anchor nearest to where the figure is expected.
 * Repeated running headers and boilerplate do produce several matches, and the
 * document-relative position is the only signal available to break the tie.
 */
function bestMatchIndex(haystack: string, needle: string, relativePosition: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;

  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;

    const distance = Math.abs(found / Math.max(1, haystack.length) - relativePosition);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = found;
    }

    from = found + 1;
  }

  return best;
}

/** The end of the block containing `from`, so a placeholder never splits one. */
function blockEnd(text: string, from: number): number {
  const next = text.indexOf("\n\n", from);
  return next === -1 ? text.length : next;
}

/**
 * Splices a placeholder for each figure into the extracted Markdown, just after
 * the block its anchor text falls in.
 *
 * Figures whose anchor is too short or cannot be found are reported as
 * unplaced rather than guessed at — a figure in the wrong place is worse than a
 * figure in an appendix.
 */
export function insertFigurePlaceholders(
  markdown: string,
  placements: FigurePlacement[]
): InsertPlaceholdersResult {
  const { normalized, offsets } = normalizeWithMap(markdown);
  const placed: FigureId[] = [];
  const unplaced: FigureId[] = [];
  const insertions: { at: number; text: string; order: number }[] = [];

  for (const [order, placement] of placements.entries()) {
    const anchor = normalizeAnchor(placement.anchorText);

    if (anchor.length < MIN_ANCHOR_CHARS) {
      unplaced.push({ page: placement.page, index: placement.index });
      continue;
    }

    const matchStart = bestMatchIndex(normalized, anchor, placement.relativePosition);
    if (matchStart === -1) {
      unplaced.push({ page: placement.page, index: placement.index });
      continue;
    }

    const sourceOffset = offsets[matchStart + anchor.length - 1] ?? markdown.length;
    insertions.push({
      at: blockEnd(markdown, sourceOffset),
      text: `\n\n${figurePlaceholder(placement)}`,
      order,
    });
    placed.push({ page: placement.page, index: placement.index });
  }

  // Applying from the end backwards keeps every earlier offset valid. Ties are
  // broken so that, after insertion, figures still read in document order.
  insertions.sort((a, b) => b.at - a.at || b.order - a.order);

  let result = markdown;
  for (const insertion of insertions) {
    result = `${result.slice(0, insertion.at)}${insertion.text}${result.slice(insertion.at)}`;
  }

  return { markdown: result, placed, unplaced };
}

/**
 * Replaces every placeholder with its figure's Markdown, keeping the comment as
 * a traceable marker. Placeholders with no matching block are removed so no
 * stray comment survives, and blocks whose placeholder is gone are reported so
 * the caller can append them instead of losing them.
 */
export function substituteFigureBlocks(
  markdown: string,
  blocks: FigureBlock[]
): SubstituteResult {
  const byId = new Map(blocks.map((block) => [figureId(block), block]));
  const seen = new Set<string>();

  const result = markdown.replace(PLACEHOLDER_PATTERN, (match, page: string, index: string) => {
    const id = `p${page}#${index}`;
    const block = byId.get(id);

    if (!block) return "";

    seen.add(id);
    const content = block.content.trim();
    return content.length > 0 ? `${match}\n\n${content}` : match;
  });

  const missing = blocks.filter((block) => !seen.has(figureId(block)));
  return { markdown: result, missing };
}

/**
 * Appends figures that could not be placed inline under a heading of their own,
 * ordered by page. Losing the placement is recoverable; losing the figure is
 * not.
 */
export function appendFigureSection(markdown: string, blocks: FigureBlock[]): string {
  if (blocks.length === 0) return markdown;

  const ordered = [...blocks].sort((a, b) => a.page - b.page || a.index - b.index);
  const sections = ordered.map((block) => {
    const heading = `### Figure — page ${block.page}${block.index > 1 ? ` (${block.index})` : ""}`;
    return `${heading}\n\n${figurePlaceholder(block)}\n\n${block.content.trim()}`;
  });

  return (
    `${markdown.trimEnd()}\n\n---\n\n` +
    "## Figures without a detected position\n\n" +
    "These were found in the document but their surrounding text could not be " +
    "located in the extraction, so they are collected here in page order.\n\n" +
    `${sections.join("\n\n")}`
  );
}
