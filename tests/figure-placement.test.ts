import { describe, expect, it } from "vitest";
import {
  appendFigureSection,
  figureId,
  figurePlaceholder,
  insertFigurePlaceholders,
  substituteFigureBlocks,
  type FigurePlacement,
} from "../src/tools/figure-placement.js";

/**
 * "La sección" with an explicitly precomposed U+00F3, so the accent tests
 * control which Unicode form each side uses instead of relying on how this file
 * happens to be saved.
 */
const ACCENTED = "La sección";

function placement(overrides: Partial<FigurePlacement> = {}): FigurePlacement {
  return {
    page: 1,
    index: 1,
    anchorText: "and then introduces the diagram that follows",
    relativePosition: 0.5,
    ...overrides,
  };
}

describe("figurePlaceholder", () => {
  it("encodes the page and index so substitution can find it again", () => {
    expect(figurePlaceholder({ page: 3, index: 2 })).toBe("<!-- veneko:figure p3#2 -->");
    expect(figureId({ page: 3, index: 2 })).toBe("p3#2");
  });
});

describe("insertFigurePlaceholders", () => {
  it("inserts the placeholder after the block its anchor falls in", () => {
    const markdown = [
      "# Chapter one",
      "and then introduces the diagram that follows",
      "The text after the diagram continues here.",
    ].join("\n\n");

    const { markdown: result, placed, unplaced } = insertFigurePlaceholders(markdown, [
      placement(),
    ]);

    expect(placed).toEqual([{ page: 1, index: 1 }]);
    expect(unplaced).toEqual([]);

    const lines = result.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toEqual([
      "# Chapter one",
      "and then introduces the diagram that follows",
      "<!-- veneko:figure p1#1 -->",
      "The text after the diagram continues here.",
    ]);
  });

  it("never splits a paragraph in half", () => {
    const markdown = "Intro line\nand then introduces the diagram that follows\nsame paragraph tail\n\nNext block";

    const { markdown: result } = insertFigurePlaceholders(markdown, [placement()]);

    expect(result).toContain("same paragraph tail\n\n<!-- veneko:figure p1#1 -->");
  });

  it("matches an anchor across differences in whitespace and punctuation", () => {
    // markitdown re-wraps lines and mangles spacing; pdf.js reports one run.
    const markdown = "Some heading\n\nand   then introduces\nthe diagram, that follows!\n\nAfter.";

    const { placed } = insertFigurePlaceholders(markdown, [placement()]);

    expect(placed).toHaveLength(1);
  });

  it("matches an anchor whose accents are normalized differently", () => {
    // The document carries a precomposed accent while the anchor arrives
    // decomposed as a plain letter plus a combining mark - pdf.js and
    // markitdown do not always agree on which form they emit.
    const sentence = `${ACCENTED} describe el diagrama siguiente con detalle`;
    const markdown = `${sentence}\n\nTexto posterior.`;
    const anchorText = sentence.normalize("NFD");

    expect(anchorText).not.toBe(sentence);

    const { markdown: result, placed } = insertFigurePlaceholders(markdown, [
      placement({ anchorText }),
    ]);

    expect(placed).toHaveLength(1);
    expect(result).toContain("con detalle\n\n<!-- veneko:figure p1#1 -->");
  });

  it("matches an anchor whose accents were dropped entirely", () => {
    // Some extractors lose diacritics outright; folding must survive that too.
    const markdown = "La seccion describe el diagrama siguiente con detalle\n\nTexto.";

    const { placed } = insertFigurePlaceholders(markdown, [
      placement({ anchorText: ACCENTED + " describe el diagrama siguiente con detalle" }),
    ]);

    expect(placed).toHaveLength(1);
  });

  it("reports a figure as unplaced when its anchor is too short to trust", () => {
    const { placed, unplaced } = insertFigurePlaceholders("Body text here.\n\nMore text.", [
      placement({ anchorText: "Fig 1" }),
    ]);

    expect(placed).toEqual([]);
    expect(unplaced).toEqual([{ page: 1, index: 1 }]);
  });

  it("reports a figure as unplaced when its anchor is nowhere in the text", () => {
    const { unplaced } = insertFigurePlaceholders("Completely unrelated content here.", [
      placement({ anchorText: "a sentence that does not appear in the extraction" }),
    ]);

    expect(unplaced).toEqual([{ page: 1, index: 1 }]);
  });

  it("picks the repeated anchor nearest the figure's position in the document", () => {
    // A running header repeated on every page: only position can break the tie.
    const header = "Confidential internal engineering handbook";
    const markdown = [
      `${header}`,
      "Page one body.",
      `${header}`,
      "Page two body.",
      `${header}`,
      "Page three body.",
    ].join("\n\n");

    const { markdown: result } = insertFigurePlaceholders(markdown, [
      placement({ page: 3, anchorText: header, relativePosition: 0.9 }),
    ]);

    const placeholderAt = result.indexOf("<!-- veneko:figure p3#1 -->");
    // It must land after the last repetition, not the first.
    expect(placeholderAt).toBeGreaterThan(result.lastIndexOf(header));
  });

  it("keeps two figures sharing one anchor in document order", () => {
    const markdown = "Text before the two figures that follow it here.\n\nText after.";
    const anchorText = "Text before the two figures that follow it here.";

    const { markdown: result } = insertFigurePlaceholders(markdown, [
      placement({ index: 1, anchorText }),
      placement({ index: 2, anchorText }),
    ]);

    expect(result.indexOf("p1#1")).toBeLessThan(result.indexOf("p1#2"));
  });

  it("keeps figures from different anchors in document order", () => {
    const markdown = [
      "The first section leads into the opening diagram.",
      "The second section leads into the closing diagram.",
    ].join("\n\n");

    const { markdown: result } = insertFigurePlaceholders(markdown, [
      placement({
        page: 1,
        anchorText: "The first section leads into the opening diagram.",
        relativePosition: 0.25,
      }),
      placement({
        page: 2,
        anchorText: "The second section leads into the closing diagram.",
        relativePosition: 0.75,
      }),
    ]);

    expect(result.indexOf("p1#1")).toBeLessThan(result.indexOf("p2#1"));
    expect(result.indexOf("p1#1")).toBeLessThan(result.indexOf("The second section"));
  });

  it("leaves the markdown untouched when there are no figures", () => {
    const markdown = "Nothing to place here.";
    expect(insertFigurePlaceholders(markdown, []).markdown).toBe(markdown);
  });
});

describe("substituteFigureBlocks", () => {
  it("replaces the placeholder with the figure content, keeping the marker", () => {
    const markdown = "Before.\n\n<!-- veneko:figure p1#1 -->\n\nAfter.";

    const { markdown: result, missing } = substituteFigureBlocks(markdown, [
      { page: 1, index: 1, content: "```mermaid\nflowchart TD\n  A --> B\n```" },
    ]);

    expect(missing).toEqual([]);
    expect(result).toContain("<!-- veneko:figure p1#1 -->\n\n```mermaid");
    expect(result).toContain("flowchart TD");
    expect(result.indexOf("Before.")).toBeLessThan(result.indexOf("flowchart"));
    expect(result.indexOf("flowchart")).toBeLessThan(result.indexOf("After."));
  });

  it("tolerates the extra whitespace a model may add inside the comment", () => {
    const markdown = "<!--  veneko:figure   p2#3  -->";

    const { markdown: result, missing } = substituteFigureBlocks(markdown, [
      { page: 2, index: 3, content: "Described." },
    ]);

    expect(missing).toEqual([]);
    expect(result).toContain("Described.");
  });

  it("reports a block whose placeholder the formatting model dropped", () => {
    const { missing } = substituteFigureBlocks("The model removed the comment.", [
      { page: 1, index: 1, content: "Orphaned content." },
    ]);

    expect(missing).toEqual([{ page: 1, index: 1, content: "Orphaned content." }]);
  });

  it("strips a placeholder that has no block rather than leaving a stray comment", () => {
    const { markdown: result } = substituteFigureBlocks(
      "Body.\n\n<!-- veneko:figure p9#9 -->\n\nMore.",
      []
    );

    expect(result).not.toContain("veneko:figure");
  });

  it("keeps the marker alone when the figure produced no content", () => {
    const { markdown: result } = substituteFigureBlocks("<!-- veneko:figure p1#1 -->", [
      { page: 1, index: 1, content: "" },
    ]);

    expect(result).toBe("<!-- veneko:figure p1#1 -->");
  });
});

describe("appendFigureSection", () => {
  it("collects unplaced figures in page order under a heading", () => {
    const result = appendFigureSection("Document body.", [
      { page: 5, index: 1, content: "Second figure." },
      { page: 2, index: 1, content: "First figure." },
    ]);

    expect(result).toContain("## Figures without a detected position");
    expect(result.indexOf("First figure.")).toBeLessThan(result.indexOf("Second figure."));
    expect(result).toContain("### Figure — page 2");
    expect(result).toContain("### Figure — page 5");
  });

  it("leaves the document alone when nothing needs appending", () => {
    expect(appendFigureSection("Body.", [])).toBe("Body.");
  });
});
