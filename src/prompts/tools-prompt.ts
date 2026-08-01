import { basename, extname, isAbsolute, join, resolve } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { c } from "../utils/logger.js";
import { fileExists } from "../utils/fs.js";
import { listOutputDestinations } from "../utils/user-dirs.js";
import { getModelLabel } from "../config/providers.js";
import { resolveToolModel } from "./model-prompt.js";
import { convertPdfToMarkdown } from "../tools/pdf-to-markdown.js";

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

async function promptOutputPath(pdfPath: string): Promise<string | null> {
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

  const fileName = `${basename(pdfPath, extname(pdfPath))}.md`;
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

export async function runToolsMenu(): Promise<void> {
  for (;;) {
    const choice = await p.select({
      message: "Tools",
      options: [
        {
          value: "pdf-to-markdown",
          label: "Scanned PDF to Markdown",
          hint: "image-only PDFs, transcribed by a vision model",
        },
        { value: BACK, label: "Back", hint: "return to main menu" },
      ],
    });

    if (p.isCancel(choice) || choice === BACK) return;

    if (choice === "pdf-to-markdown") {
      await runPdfToMarkdownTool();
    }
  }
}
