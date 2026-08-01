import { basename, extname, isAbsolute, join, resolve } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { c } from "../utils/logger.js";
import { fileExists } from "../utils/fs.js";
import { listOutputDestinations } from "../utils/user-dirs.js";
import { getModelLabel } from "../config/providers.js";
import { resolveToolModel } from "./model-prompt.js";
import { convertPdfToMarkdown } from "../tools/pdf-to-markdown.js";
import { convertDocumentToMarkdown } from "../tools/document-to-markdown.js";
import {
  detectMarkitdown,
  MARKITDOWN_EXTENSIONS,
  MARKITDOWN_INSTALL_HINT,
} from "../tools/markitdown.js";

const BACK = "__back__";

/** Terminals paste dragged paths wrapped in quotes; strip them before resolving. */
function cleanPath(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

async function promptPdfPath(): Promise<string | null> {
  const input = await p.text({
    message: "Path to the scanned PDF",
    placeholder: "./book.pdf",
    validate: (value) => {
      if (!value || value.trim().length === 0) return "A PDF path is required.";
      if (extname(cleanPath(value)).toLowerCase() !== ".pdf") return "The file must be a .pdf";
      return undefined;
    },
  });

  if (p.isCancel(input)) return null;

  const pdfPath = cleanPath(input);
  if (!(await fileExists(pdfPath))) {
    p.log.error(`${c.error("✖ File not found:")} ${pc.dim(pdfPath)}`);
    return null;
  }

  return pdfPath;
}

async function promptOutputPath(sourcePath: string): Promise<string | null> {
  const destinations = await listOutputDestinations();

  const choice = await p.select({
    message: "Where do you want to save the Markdown?",
    options: destinations.map((destination) => ({
      value: destination.value,
      label: destination.label,
      hint: destination.path,
    })),
  });

  if (p.isCancel(choice)) return null;

  const destination = destinations.find((item) => item.value === choice);
  if (!destination) return null;

  const fileName = `${basename(sourcePath, extname(sourcePath))}.md`;
  const outputPath = join(destination.path, fileName);

  if (await fileExists(outputPath)) {
    const overwrite = await p.confirm({
      message: `${fileName} already exists there. Overwrite it?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) return null;
  }

  return outputPath;
}

async function runPdfToMarkdownTool(): Promise<void> {
  p.log.info(
    `${c.dim("▸")} ${pc.bold("Scanned PDF to Markdown")}\n` +
    pc.dim("  Renders each page as an image and transcribes it with a vision model.\n") +
    pc.dim("  Built for image-only PDFs (scans, photographed books) — not for PDFs with a text layer.")
  );

  const pdfPath = await promptPdfPath();
  if (!pdfPath) return;

  const outputPath = await promptOutputPath(pdfPath);
  if (!outputPath) return;

  const resolved = await resolveToolModel();
  if (!resolved) return;

  p.note(
    [
      `${pc.bold("Source")}   ${pc.dim(pdfPath)}`,
      `${pc.bold("Output")}   ${pc.dim(outputPath)}`,
      `${pc.bold("Model")}    ${c.highlight(getModelLabel(resolved.provider, resolved.model))} ${pc.dim(`(${resolved.provider})`)}`,
      "",
      pc.dim("Every page costs one model request, so long books take a while."),
    ].join("\n"),
    pc.bold("▸ Transcription summary")
  );

  const proceed = await p.confirm({ message: "Start transcription?", initialValue: true });
  if (p.isCancel(proceed) || !proceed) {
    p.log.warn(`${c.warn("⚠")} Transcription cancelled.`);
    return;
  }

  const s = p.spinner();
  s.start(`${c.dim("▸")} Transcribing pages...`);

  try {
    const result = await convertPdfToMarkdown({
      pdfPath,
      outputPath,
      provider: resolved.provider,
      model: resolved.model,
      apiKey: resolved.apiKey,
      onPageDone: ({ completed, total }) => {
        s.message(`${c.dim("▸")} Transcribing pages... ${c.highlight(`${completed}/${total}`)}`);
      },
    });

    if (result.failedPages.length > 0) {
      s.stop(`${c.warn("⚠")} Finished with ${result.failedPages.length} failed page(s).`);
      p.log.warn(
        `Pages that failed: ${result.failedPages.join(", ")}\n` +
        pc.dim("  The Markdown marks each one with an HTML comment so you can retry them.")
      );
    } else {
      s.stop(`${c.success("✔")} Transcribed ${result.pagesProcessed} page(s).`);
    }

    p.log.success(`${c.success("✔")} Saved to ${c.highlight(result.outputPath)}`);
  } catch (err) {
    s.stop(`${c.error("✖")} Transcription failed.`);
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

async function promptDocumentPath(): Promise<string | null> {
  const input = await p.text({
    message: "Path to the document",
    placeholder: "./report.docx",
    validate: (value) => {
      if (!value || value.trim().length === 0) return "A file path is required.";
      return undefined;
    },
  });

  if (p.isCancel(input)) return null;

  const filePath = cleanPath(input);
  if (!(await fileExists(filePath))) {
    p.log.error(`${c.error("✖ File not found:")} ${pc.dim(filePath)}`);
    return null;
  }

  const extension = extname(filePath).toLowerCase();
  if (!MARKITDOWN_EXTENSIONS.includes(extension)) {
    const proceed = await p.confirm({
      message: `${extension || "This file"} is not a format veneko knows markitdown handles. Try anyway?`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) return null;
  }

  return filePath;
}

async function runDocumentToMarkdownTool(): Promise<void> {
  p.log.info(
    `${c.dim("▸")} ${pc.bold("Document to Markdown")}\n` +
    pc.dim("  Extracts the document with Microsoft markitdown, then has an AI clean up the result.\n") +
    pc.dim("  Word, PowerPoint, Excel, EPUB, HTML, CSV, Outlook messages and text-layer PDFs.")
  );

  const markitdown = await detectMarkitdown();
  if (!markitdown) {
    p.log.error(`${c.error("✖")} ${MARKITDOWN_INSTALL_HINT}`);
    return;
  }

  const filePath = await promptDocumentPath();
  if (!filePath) return;

  const outputPath = await promptOutputPath(filePath);
  if (!outputPath) return;

  const cleanup = await p.confirm({
    message: "Clean up the extracted Markdown with AI?",
    initialValue: true,
  });
  if (p.isCancel(cleanup)) return;

  const resolved = cleanup ? await resolveToolModel() : null;
  if (cleanup && !resolved) return;

  p.note(
    [
      `${pc.bold("Source")}   ${pc.dim(filePath)}`,
      `${pc.bold("Output")}   ${pc.dim(outputPath)}`,
      `${pc.bold("Extract")}  ${pc.dim(markitdown.label)}`,
      `${pc.bold("Format")}   ${
        resolved
          ? `${c.highlight(getModelLabel(resolved.provider, resolved.model))} ${pc.dim(`(${resolved.provider})`)}`
          : pc.dim("skipped — raw markitdown output")
      }`,
      "",
      pc.dim("markitdown takes about ten seconds to start up before it converts anything."),
      pc.dim("Long documents are then formatted in fragments, one model request each."),
    ].join("\n"),
    pc.bold("▸ Conversion summary")
  );

  const proceed = await p.confirm({ message: "Start conversion?", initialValue: true });
  if (p.isCancel(proceed) || !proceed) {
    p.log.warn(`${c.warn("⚠")} Conversion cancelled.`);
    return;
  }

  const s = p.spinner();
  s.start(`${c.dim("▸")} Extracting with markitdown...`);

  try {
    const result = await convertDocumentToMarkdown({
      filePath,
      outputPath,
      markitdownCommand: markitdown,
      raw: !resolved,
      provider: resolved?.provider ?? "openai",
      model: resolved?.model ?? "",
      apiKey: resolved?.apiKey ?? "",
      onStage: (stage) => {
        if (stage === "formatting") s.message(`${c.dim("▸")} Formatting with AI...`);
        if (stage === "writing") s.message(`${c.dim("▸")} Writing Markdown...`);
      },
      onChunkDone: ({ completed, total }) => {
        s.message(`${c.dim("▸")} Formatting with AI... ${c.highlight(`${completed}/${total}`)}`);
      },
    });

    if (result.failedChunks.length > 0) {
      s.stop(`${c.warn("⚠")} Finished with ${result.failedChunks.length} unformatted fragment(s).`);
      p.log.warn(
        `Fragments the model did not return: ${result.failedChunks.join(", ")}\n` +
        pc.dim("  Their raw extracted text was kept, so no content was lost.")
      );
    } else if (result.formatted) {
      s.stop(`${c.success("✔")} Formatted ${result.chunks} fragment(s).`);
    } else {
      s.stop(`${c.success("✔")} Extracted ${result.rawChars} characters.`);
    }

    p.log.success(`${c.success("✔")} Saved to ${c.highlight(result.outputPath)}`);
  } catch (err) {
    s.stop(`${c.error("✖")} Conversion failed.`);
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

export async function runToolsMenu(): Promise<void> {
  for (;;) {
    const choice = await p.select({
      message: "Tools",
      options: [
        {
          value: "document-to-markdown",
          label: "Document to Markdown",
          hint: "Word, Excel, PowerPoint, EPUB and more, via markitdown + AI cleanup",
        },
        {
          value: "pdf-to-markdown",
          label: "Scanned PDF to Markdown",
          hint: "image-only PDFs, transcribed by a vision model",
        },
        { value: BACK, label: "Back", hint: "return to main menu" },
      ],
    });

    if (p.isCancel(choice) || choice === BACK) return;

    if (choice === "document-to-markdown") {
      await runDocumentToMarkdownTool();
    }

    if (choice === "pdf-to-markdown") {
      await runPdfToMarkdownTool();
    }
  }
}
