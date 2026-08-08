import { stat } from "fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { c } from "../utils/logger.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { parseDraggedPaths } from "../utils/dragged-paths.js";
import { listMediaDestinations, listOutputDestinations } from "../utils/user-dirs.js";
import { getModelLabel, getTranscriptionModelLabel } from "../config/providers.js";
import { resolveToolModel, resolveTranscriptionModel } from "./model-prompt.js";
import { convertPdfToMarkdown } from "../tools/pdf-to-markdown.js";
import {
  convertAudioToMarkdown,
  FFMPEG_AUDIO_HINT,
  type AudioToMarkdownResult,
  type ModelCredentials,
} from "../tools/audio-to-markdown.js";
import { AUDIO_EXTENSIONS, isAudioFile } from "../tools/audio-prepare.js";
import {
  convertDocumentToMarkdown,
  type DocumentToMarkdownResult,
} from "../tools/document-to-markdown.js";
import {
  detectMarkitdown,
  MARKITDOWN_EXTENSIONS,
  MARKITDOWN_INSTALL_HINT,
} from "../tools/markitdown.js";
import {
  detectFfmpeg,
  detectYtDlp,
  formatBytes,
  formatEta,
  formatSpeed,
  probeUrl,
  runDownload,
  FFMPEG_INSTALL_HINT,
  YTDLP_INSTALL_HINT,
  type AudioFormat,
  type DownloadOptions,
  type MediaInfo,
  type VideoContainer,
} from "../tools/yt-dlp.js";

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

/** Reports what happened to the figures, including anything that was dropped. */
function reportFigures(result: DocumentToMarkdownResult): void {
  if (result.figuresFound === 0) {
    p.log.info(`${c.dim("▸")} No images found in the PDF — only its text layer was converted.`);
    return;
  }

  p.log.success(
    `${c.success("✔")} Converted ${result.figuresDescribed} of ${result.figuresFound} figure(s).`
  );

  if (result.figuresRejected > 0) {
    p.log.info(
      `${c.dim("▸")} ${result.figuresRejected} region(s) turned out not to be figures.\n` +
      pc.dim("  Table borders, rules and frames look like drawings, so the model checks each\n") +
      pc.dim("  one and these were discarded. They leave no trace in the Markdown.")
    );
  }

  if (result.failedFigures.length > 0) {
    p.log.warn(
      `${c.warn("⚠")} Figures the model could not read: ${result.failedFigures.join(", ")}\n` +
      pc.dim("  Each one is marked in the Markdown with an HTML comment so you can retry it.")
    );
  }

  if (result.figuresAppended > 0) {
    p.log.warn(
      `${c.warn("⚠")} ${result.figuresAppended} figure(s) could not be placed in the text.\n` +
      pc.dim('  They are collected under "Figures without a detected position" at the end.')
    );
  }

  if (result.figuresSkipped > 0) {
    p.log.warn(
      `${c.warn("⚠")} ${result.figuresSkipped} image region(s) were skipped by the per-page limit.\n` +
      pc.dim("  Pages crowded with images keep only the largest ones.")
    );
  }
}

async function runDocumentToMarkdownTool(): Promise<void> {
  p.log.info(
    `${c.dim("▸")} ${pc.bold("Document to Markdown")}\n` +
    pc.dim("  Extracts the document with Microsoft markitdown, then has an AI clean up the result.\n") +
    pc.dim("  Word, PowerPoint, Excel, EPUB, HTML, CSV, Outlook messages and text-layer PDFs.\n") +
    pc.dim("  For PDFs it can also read the embedded images and write them into the Markdown.")
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

  // Only PDFs expose their embedded images to inspection, so the question is
  // meaningless for every other format.
  const isPdf = extname(filePath).toLowerCase() === ".pdf";
  let figures = false;

  if (isPdf) {
    p.log.info(
      `${c.dim("▸")} ${pc.bold("Figures")}\n` +
      pc.dim("  markitdown reads a PDF's text layer and ignores everything drawn on it.\n") +
      pc.dim("  veneko can crop each figure out and have a vision model read it: diagrams\n") +
      pc.dim("  become Mermaid, circuits become component and connection lists, charts\n") +
      pc.dim("  become tables, photos get described — each one placed where it appeared.\n") +
      pc.dim("  Both embedded images and vector drawings are found, so diagrams exported\n") +
      pc.dim("  from Visio, draw.io or TikZ are picked up too.")
    );

    const wantFigures = await p.confirm({
      message: "Detect figures in the PDF and convert them too?",
      initialValue: true,
    });
    if (p.isCancel(wantFigures)) return;
    figures = wantFigures;
  }

  // Figures need a vision model even when the formatting pass is skipped.
  const resolved = cleanup || figures ? await resolveToolModel() : null;
  if ((cleanup || figures) && !resolved) return;

  p.note(
    [
      `${pc.bold("Source")}   ${pc.dim(filePath)}`,
      `${pc.bold("Output")}   ${pc.dim(outputPath)}`,
      `${pc.bold("Extract")}  ${pc.dim(markitdown.label)}`,
      `${pc.bold("Format")}   ${
        cleanup && resolved
          ? `${c.highlight(getModelLabel(resolved.provider, resolved.model))} ${pc.dim(`(${resolved.provider})`)}`
          : pc.dim("skipped — raw markitdown output")
      }`,
      `${pc.bold("Figures")}  ${
        figures
          ? c.highlight("on")
          : pc.dim(isPdf ? "off" : "not available for this format")
      }`,
      "",
      pc.dim("markitdown takes about ten seconds to start up before it converts anything."),
      pc.dim("Long documents are then formatted in fragments, one model request each."),
      ...(figures
        ? [pc.dim("Every detected image costs one extra vision request on top of that.")]
        : []),
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
      raw: !cleanup,
      figures,
      provider: resolved?.provider ?? "openai",
      model: resolved?.model ?? "",
      apiKey: resolved?.apiKey ?? "",
      onStage: (stage) => {
        if (stage === "scanning-figures") s.message(`${c.dim("▸")} Scanning pages for images...`);
        if (stage === "describing-figures") s.message(`${c.dim("▸")} Reading figures...`);
        if (stage === "formatting") s.message(`${c.dim("▸")} Formatting with AI...`);
        if (stage === "writing") s.message(`${c.dim("▸")} Writing Markdown...`);
      },
      onFigureDone: ({ completed, total }) => {
        s.message(`${c.dim("▸")} Reading figures... ${c.highlight(`${completed}/${total}`)}`);
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

    if (figures) reportFigures(result);

    p.log.success(`${c.success("✔")} Saved to ${c.highlight(result.outputPath)}`);
  } catch (err) {
    s.stop(`${c.error("✖")} Conversion failed.`);
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "unknown length";
  return formatEta(seconds);
}

async function promptMediaUrl(): Promise<string | null> {
  const input = await p.text({
    message: "Video or playlist URL",
    placeholder: "https://www.youtube.com/watch?v=...",
    validate: (value) => {
      const url = (value ?? "").trim();
      if (url.length === 0) return "A URL is required.";
      if (!/^https?:\/\//i.test(url)) return "The URL must start with http:// or https://";
      return undefined;
    },
  });

  if (p.isCancel(input)) return null;
  return input.trim();
}

async function promptDownloadDir(): Promise<string | null> {
  const destinations = await listMediaDestinations();

  const choice = await p.select({
    message: "Where do you want to save the download?",
    options: destinations.map((destination) => ({
      value: destination.value,
      label: destination.label,
      hint: destination.path,
    })),
  });

  if (p.isCancel(choice)) return null;
  return destinations.find((item) => item.value === choice)?.path ?? null;
}

/** Video-specific questions: how big, and in which container. */
async function promptVideoOptions(
  hasFfmpeg: boolean
): Promise<{ maxHeight: number | "best"; container: VideoContainer } | null> {
  const quality = await p.select({
    message: "Maximum quality",
    initialValue: "1080",
    options: [
      { value: "best", label: "Best available", hint: "whatever the source offers, up to 4K+" },
      { value: "2160", label: "2160p", hint: "4K" },
      { value: "1440", label: "1440p", hint: "2K" },
      { value: "1080", label: "1080p", hint: "Full HD — the usual choice" },
      { value: "720", label: "720p", hint: "HD, smaller files" },
      { value: "480", label: "480p", hint: "lightest" },
    ],
  });
  if (p.isCancel(quality)) return null;

  // Without ffmpeg there is nothing to mux into, so the container is whatever
  // the single progressive stream already is.
  if (!hasFfmpeg) {
    return { maxHeight: quality === "best" ? "best" : Number(quality), container: "mp4" };
  }

  const container = await p.select({
    message: "Container",
    initialValue: "mp4",
    options: [
      { value: "mp4", label: "MP4", hint: "H.264 + AAC — plays on anything" },
      { value: "mkv", label: "MKV", hint: "best available codecs, less portable" },
    ],
  });
  if (p.isCancel(container)) return null;

  return {
    maxHeight: quality === "best" ? "best" : Number(quality),
    container: container as VideoContainer,
  };
}

/** Audio-specific questions: which codec, and at what quality. */
async function promptAudioOptions(): Promise<{ format: AudioFormat; quality: string } | null> {
  const format = await p.select({
    message: "Audio format",
    initialValue: "mp3",
    options: [
      { value: "mp3", label: "MP3", hint: "universal, re-encoded from the source" },
      { value: "m4a", label: "M4A (AAC)", hint: "usually copied as-is from YouTube — no quality loss" },
      { value: "opus", label: "Opus", hint: "best quality per byte, fewer players support it" },
      { value: "flac", label: "FLAC", hint: "lossless container around a lossy source — big files" },
      { value: "wav", label: "WAV", hint: "uncompressed, for editing" },
    ],
  });
  if (p.isCancel(format)) return null;

  if (format !== "mp3") return { format: format as AudioFormat, quality: "0" };

  const quality = await p.select({
    message: "MP3 quality",
    initialValue: "0",
    options: [
      { value: "0", label: "Best", hint: "VBR ~245 kbps" },
      { value: "192K", label: "High", hint: "192 kbps" },
      { value: "128K", label: "Standard", hint: "128 kbps, smallest" },
    ],
  });
  if (p.isCancel(quality)) return null;

  return { format: "mp3", quality: quality as string };
}

/**
 * Everything that is off by default and rarely needed. Kept behind one confirm
 * so the common case stays a short conversation.
 */
async function promptAdvancedOptions(): Promise<Partial<DownloadOptions> | null> {
  const wanted = await p.confirm({
    message: "Configure advanced options?",
    initialValue: false,
  });
  if (p.isCancel(wanted)) return null;
  if (!wanted) return {};

  const browser = await p.select({
    message: "Use cookies from a browser?",
    initialValue: "none",
    options: [
      { value: "none", label: "No", hint: "public videos need no session" },
      { value: "chrome", label: "Chrome" },
      { value: "edge", label: "Edge" },
      { value: "firefox", label: "Firefox" },
      { value: "brave", label: "Brave" },
    ],
  });
  if (p.isCancel(browser)) return null;

  const limitRate = await p.text({
    message: "Speed limit (empty for none)",
    placeholder: "2M",
    defaultValue: "",
    validate: (value) => {
      const raw = (value ?? "").trim();
      if (raw.length === 0) return undefined;
      return /^\d+(\.\d+)?[KMG]?$/i.test(raw) ? undefined : "Use a size like 500K, 2M or 1.5M.";
    },
  });
  if (p.isCancel(limitRate)) return null;

  const archive = await p.confirm({
    message: "Keep a download archive in that folder?",
    initialValue: false,
  });
  if (p.isCancel(archive)) return null;

  return {
    cookiesFromBrowser: browser === "none" ? undefined : (browser as string),
    limitRate: limitRate.trim() || undefined,
    archivePath: archive ? "veneko-archive.txt" : undefined,
  };
}

/** Playlist URLs are ambiguous: the user may only want the video they clicked. */
async function promptPlaylistScope(
  info: MediaInfo
): Promise<{ playlist: boolean; playlistItems?: string } | null> {
  if (!info.isPlaylist) return { playlist: false };

  const scope = await p.select({
    message: `This URL is a playlist with ${info.entryCount} item(s). What do you want?`,
    initialValue: "all",
    options: [
      { value: "all", label: "The whole playlist" },
      { value: "range", label: "A range of items", hint: "e.g. 1-10, 15, 20-25" },
      { value: "single", label: "Only the video the link points at" },
    ],
  });
  if (p.isCancel(scope)) return null;
  if (scope === "single") return { playlist: false };
  if (scope === "all") return { playlist: true };

  const items = await p.text({
    message: "Items to download",
    placeholder: "1-10",
    validate: (value) => {
      const raw = (value ?? "").trim();
      if (raw.length === 0) return "A range is required.";
      return /^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/.test(raw)
        ? undefined
        : "Use numbers and ranges, like 1-10,15,20-25.";
    },
  });
  if (p.isCancel(items)) return null;

  return { playlist: true, playlistItems: items.trim() };
}

async function runMediaDownloadTool(): Promise<void> {
  p.log.info(
    `${c.dim("▸")} ${pc.bold("Download video or audio")}\n` +
    pc.dim("  Pulls a video, an MP3 or a whole playlist with yt-dlp.\n") +
    pc.dim("  Works with YouTube and the thousand-odd other sites yt-dlp supports.")
  );

  const ytDlp = await detectYtDlp();
  if (!ytDlp) {
    p.log.error(`${c.error("✖")} ${YTDLP_INSTALL_HINT}`);
    return;
  }

  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) {
    p.log.warn(`${c.warn("⚠")} ${FFMPEG_INSTALL_HINT}`);
  }

  const url = await promptMediaUrl();
  if (!url) return;

  const probe = p.spinner();
  probe.start(`${c.dim("▸")} Reading the URL...`);

  let info: MediaInfo;
  try {
    info = await probeUrl(url, { command: ytDlp });
    probe.stop(`${c.success("✔")} ${info.title}`);
  } catch (err) {
    probe.stop(`${c.error("✖")} Could not read that URL.`);
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  p.note(
    [
      `${pc.bold("Title")}     ${info.title}`,
      `${pc.bold("Channel")}   ${pc.dim(info.uploader ?? "unknown")}`,
      info.isPlaylist
        ? `${pc.bold("Items")}     ${pc.dim(`${info.entryCount} video(s)`)}`
        : `${pc.bold("Length")}    ${pc.dim(formatDuration(info.duration))}`,
      `${pc.bold("Source")}    ${pc.dim(info.extractor ?? "unknown extractor")}`,
    ].join("\n"),
    pc.bold("▸ Found")
  );

  const scope = await promptPlaylistScope(info);
  if (!scope) return;

  const mode = await p.select({
    message: "What do you want to download?",
    initialValue: "video",
    options: [
      { value: "video", label: "Video", hint: "video and audio in one file" },
      {
        value: "audio",
        label: "Audio only",
        hint: ffmpeg ? "MP3, M4A, Opus, FLAC or WAV" : "needs ffmpeg — not installed",
      },
    ],
  });
  if (p.isCancel(mode)) return;

  if (mode === "audio" && !ffmpeg) {
    p.log.error(`${c.error("✖")} ${FFMPEG_INSTALL_HINT}`);
    return;
  }

  const video = mode === "video" ? await promptVideoOptions(Boolean(ffmpeg)) : null;
  if (mode === "video" && !video) return;

  const audio = mode === "audio" ? await promptAudioOptions() : null;
  if (mode === "audio" && !audio) return;

  const extraOptions = [
    { value: "metadata", label: "Embed metadata", hint: "title, channel, upload date" },
    { value: "thumbnail", label: "Embed thumbnail", hint: "cover art inside the file" },
    ...(mode === "video"
      ? [
          { value: "chapters", label: "Embed chapters", hint: "seekable sections" },
          { value: "subtitles", label: "Subtitles", hint: "written as .srt, auto-generated included" },
          ...(ffmpeg
            ? [{ value: "sponsorblock", label: "Cut sponsor segments", hint: "via SponsorBlock" }]
            : []),
        ]
      : []),
  ];

  const extras = await p.multiselect({
    message: "Extras",
    required: false,
    initialValues: ["metadata", "thumbnail"],
    options: extraOptions,
  });
  if (p.isCancel(extras)) return;

  const wantsSubtitles = extras.includes("subtitles");
  let subtitleLangs = "es,en";
  let embedSubs = false;

  if (wantsSubtitles) {
    const langs = await p.text({
      message: "Subtitle languages",
      placeholder: "es,en",
      defaultValue: "es,en",
    });
    if (p.isCancel(langs)) return;
    subtitleLangs = langs.trim() || "es,en";

    if (ffmpeg) {
      const embed = await p.confirm({
        message: "Also embed the subtitles into the video?",
        initialValue: true,
      });
      if (p.isCancel(embed)) return;
      embedSubs = embed;
    }
  }

  const outputDir = await promptDownloadDir();
  if (!outputDir) return;

  const advanced = await promptAdvancedOptions();
  if (!advanced) return;

  const options: DownloadOptions = {
    url,
    outputDir,
    mode: mode as "video" | "audio",
    maxHeight: video?.maxHeight,
    container: video?.container,
    audioFormat: audio?.format,
    audioQuality: audio?.quality,
    playlist: scope.playlist,
    playlistItems: scope.playlistItems,
    embedThumbnail: extras.includes("thumbnail"),
    embedMetadata: extras.includes("metadata"),
    embedChapters: extras.includes("chapters"),
    subtitles: wantsSubtitles,
    subtitleLangs,
    embedSubs,
    sponsorblock: extras.includes("sponsorblock"),
    hasFfmpeg: Boolean(ffmpeg),
    ...advanced,
    // The archive lives next to the files it tracks.
    archivePath: advanced.archivePath ? join(outputDir, advanced.archivePath) : undefined,
  };

  const quality =
    mode === "video"
      ? `${video?.maxHeight === "best" ? "best available" : `${video?.maxHeight}p`} ${pc.dim(`(${video?.container})`)}`
      : `${audio?.format?.toUpperCase()} ${pc.dim(`(${audio?.quality === "0" ? "best" : audio?.quality})`)}`;

  p.note(
    [
      `${pc.bold("Source")}    ${pc.dim(url)}`,
      `${pc.bold("Output")}    ${pc.dim(outputDir)}`,
      `${pc.bold("Format")}    ${c.highlight(mode === "video" ? "Video" : "Audio")} ${quality}`,
      `${pc.bold("Items")}     ${pc.dim(
        scope.playlist ? scope.playlistItems ?? `all ${info.entryCount}` : "single video"
      )}`,
      `${pc.bold("Tool")}      ${pc.dim(ytDlp.label)}${ffmpeg ? pc.dim(" + ffmpeg") : ""}`,
      ...(options.cookiesFromBrowser
        ? [`${pc.bold("Cookies")}   ${pc.dim(options.cookiesFromBrowser)}`]
        : []),
      ...(options.limitRate ? [`${pc.bold("Limit")}     ${pc.dim(options.limitRate)}`] : []),
    ].join("\n"),
    pc.bold("▸ Download summary")
  );

  const proceed = await p.confirm({ message: "Start download?", initialValue: true });
  if (p.isCancel(proceed) || !proceed) {
    p.log.warn(`${c.warn("⚠")} Download cancelled.`);
    return;
  }

  await ensureDir(outputDir);

  const s = p.spinner();
  s.start(`${c.dim("▸")} Starting yt-dlp...`);

  const total = scope.playlist ? info.entryCount : 1;
  let completed = 0;

  try {
    const result = await runDownload({
      ...options,
      command: ytDlp,
      onProgress: (progress) => {
        const counter = total > 1 ? `${c.highlight(`${completed + 1}/${total}`)} ` : "";

        if (progress.status !== "downloading") {
          s.message(`${c.dim("▸")} ${counter}Processing...`);
          return;
        }

        const percent = progress.percent === null ? "--" : progress.percent.toFixed(1);
        s.message(
          `${c.dim("▸")} ${counter}${c.highlight(`${percent}%`)} ` +
          pc.dim(
            `of ${formatBytes(progress.totalBytes)} · ${formatSpeed(progress.speed)} · ETA ${formatEta(progress.eta)}`
          )
        );
      },
      onFileDone: (_file, done) => {
        completed = done;
      },
    });

    if (result.files.length === 0) {
      s.stop(`${c.warn("⚠")} Nothing was downloaded.`);
      p.log.warn("Everything was already in the download archive, or every item was skipped.");
      return;
    }

    s.stop(`${c.success("✔")} Downloaded ${result.files.length} file(s).`);

    if (result.warnings.length > 0) {
      p.log.warn(
        `Some items failed:\n${result.warnings.slice(0, 5).join("\n")}\n` +
        pc.dim("  The rest of the playlist finished normally.")
      );
    }

    const shown = result.files.slice(0, 5);
    p.log.success(
      `${c.success("✔")} Saved to ${c.highlight(outputDir)}\n` +
      shown.map((file) => pc.dim(`  ${basename(file)}`)).join("\n") +
      (result.files.length > shown.length
        ? pc.dim(`\n  ...and ${result.files.length - shown.length} more`)
        : "")
    );
  } catch (err) {
    s.stop(`${c.error("✖")} Download failed.`);
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

interface AudioJob {
  audioPath: string;
  outputPath: string;
  size: number;
}

/**
 * Reads one line of dragged files and keeps the ones veneko can actually
 * convert. Everything dropped is reported back, because a path that silently
 * vanished from a batch of twenty is a bug the user finds hours later.
 */
async function promptAudioPaths(): Promise<{ path: string; size: number }[] | null> {
  const input = await p.text({
    message: "Drag the audio files here, or type their paths",
    placeholder: "./voice-note.ogg ./meeting.mp3",
    validate: (value) => {
      if (!value || value.trim().length === 0) return "At least one audio file is required.";
      return undefined;
    },
  });

  if (p.isCancel(input)) return null;

  const paths = parseDraggedPaths(input);
  const files: { path: string; size: number }[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];

  for (const path of paths) {
    if (!(await fileExists(path))) {
      missing.push(path);
      continue;
    }
    if (!isAudioFile(path)) {
      unsupported.push(path);
      continue;
    }
    files.push({ path, size: (await stat(path)).size });
  }

  if (missing.length > 0) {
    p.log.error(
      `${c.error("✖ Not found:")}\n` +
      missing.map((path) => pc.dim(`  ${path}`)).join("\n") +
      pc.dim("\n  A path with spaces that your terminal did not quote splits in two — ") +
      pc.dim("wrap it in quotes and try again.")
    );
  }

  if (unsupported.length > 0) {
    p.log.warn(
      `${c.warn("⚠ Not an audio format veneko handles:")}\n` +
      unsupported.map((path) => pc.dim(`  ${basename(path)}`)).join("\n") +
      pc.dim(`\n  Supported: ${AUDIO_EXTENSIONS.join(" ")}`)
    );
  }

  if (files.length === 0) {
    p.log.error(`${c.error("✖")} Nothing left to convert.`);
    return null;
  }

  if (missing.length > 0 || unsupported.length > 0) {
    const proceed = await p.confirm({
      message: `Continue with the ${files.length} file(s) that are usable?`,
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) return null;
  }

  return files;
}

const OTHER_FOLDER = "__other__";

async function promptOutputDir(): Promise<string | null> {
  const destinations = await listOutputDestinations();

  const choice = await p.select({
    message: "Where do you want to save the Markdown files?",
    options: [
      ...destinations.map((destination) => ({
        value: destination.value,
        label: destination.label,
        hint: destination.path,
      })),
      { value: OTHER_FOLDER, label: "Another folder", hint: "type or drag the path" },
    ],
  });

  if (p.isCancel(choice)) return null;

  if (choice !== OTHER_FOLDER) {
    return destinations.find((item) => item.value === choice)?.path ?? null;
  }

  const input = await p.text({
    message: "Output folder",
    placeholder: "./transcripts",
    validate: (value) => {
      if (!value || value.trim().length === 0) return "A folder path is required.";
      return undefined;
    },
  });
  if (p.isCancel(input)) return null;

  return cleanPath(input);
}

/**
 * Two recordings with the same name in different folders would write to the
 * same Markdown file, and the second would quietly overwrite the first.
 */
function uniqueOutputPath(taken: Set<string>, outputDir: string, audioPath: string): string {
  const stem = basename(audioPath, extname(audioPath));
  let candidate = join(outputDir, `${stem}.md`);
  let suffix = 2;

  while (taken.has(candidate)) {
    candidate = join(outputDir, `${stem}-${suffix}.md`);
    suffix += 1;
  }

  taken.add(candidate);
  return candidate;
}

/** Drops the jobs whose Markdown already exists, once the user has said no to overwriting. */
async function resolveOverwrites(jobs: AudioJob[]): Promise<AudioJob[] | null> {
  const existing: AudioJob[] = [];
  for (const job of jobs) {
    if (await fileExists(job.outputPath)) existing.push(job);
  }

  if (existing.length === 0) return jobs;

  const overwrite = await p.confirm({
    message: `${existing.length} Markdown file(s) already exist there. Overwrite them?`,
    initialValue: false,
  });
  if (p.isCancel(overwrite)) return null;
  if (overwrite) return jobs;

  const remaining = jobs.filter((job) => !existing.includes(job));
  if (remaining.length === 0) {
    p.log.warn(`${c.warn("⚠")} Every file was already converted. Nothing to do.`);
    return null;
  }

  p.log.info(`${c.dim("▸")} Skipping ${existing.length} file(s) that already exist.`);
  return remaining;
}

/** Reports the parts of one recording that did not come through cleanly. */
function reportAudioResult(name: string, result: AudioToMarkdownResult): void {
  if (result.failedSegments.length > 0) {
    p.log.warn(
      `${c.warn("⚠")} ${name}: ${result.failedSegments.length} segment(s) failed.\n` +
      pc.dim("  Each one is marked in the Markdown with an HTML comment, and the rest of\n") +
      pc.dim("  the recording was transcribed normally.")
    );
  }

  if (result.failedChunks.length > 0) {
    p.log.warn(
      `${c.warn("⚠")} ${name}: ${result.failedChunks.length} fragment(s) were left unformatted.\n` +
      pc.dim("  Their raw transcript was kept, so no words were lost.")
    );
  }
}

async function runAudioToMarkdownTool(): Promise<void> {
  p.log.info(
    `${c.dim("▸")} ${pc.bold("Audio to Markdown")}\n` +
    pc.dim("  Transcribes voice notes and recordings, then formats them as Markdown.\n") +
    pc.dim("  Drop several files at once and each one becomes its own .md.\n") +
    pc.dim("  MP3, OGG and Opus voice notes, plus M4A, WAV, FLAC and WebM.")
  );

  const files = await promptAudioPaths();
  if (!files) return;

  const outputDir = await promptOutputDir();
  if (!outputDir) return;

  const language = await p.text({
    message: "Language of the recordings (leave empty to detect it)",
    placeholder: "es",
    defaultValue: "",
    validate: (value) => {
      const raw = (value ?? "").trim();
      if (raw.length === 0) return undefined;
      return /^[a-z]{2}$/i.test(raw) ? undefined : "Use a two-letter code like es, en or pt.";
    },
  });
  if (p.isCancel(language)) return;

  const transcription = await resolveTranscriptionModel();
  if (!transcription) return;

  const wantsCleanup = await p.confirm({
    message: "Format the transcript with AI?",
    initialValue: true,
  });
  if (p.isCancel(wantsCleanup)) return;

  // A speech model returns one long run of text. Punctuation, paragraphs and
  // headings are a second, ordinary chat request.
  const cleanup = wantsCleanup ? await resolveToolModel() : null;
  if (wantsCleanup && !cleanup) return;

  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) {
    p.log.warn(
      `${c.warn("⚠")} ${FFMPEG_AUDIO_HINT}\n` +
      pc.dim("  Without it each recording is uploaded whole, so a long one may come back\n") +
      pc.dim("  cut short and formats the provider does not read will be rejected.")
    );
  }

  const taken = new Set<string>();
  let jobs: AudioJob[] = files.map((file) => ({
    audioPath: file.path,
    size: file.size,
    outputPath: uniqueOutputPath(taken, outputDir, file.path),
  }));

  const kept = await resolveOverwrites(jobs);
  if (!kept) return;
  jobs = kept;

  const totalBytes = jobs.reduce((sum, job) => sum + job.size, 0);
  const shown = jobs.slice(0, 5);

  p.note(
    [
      `${pc.bold("Files")}     ${c.highlight(String(jobs.length))} ${pc.dim(`(${formatBytes(totalBytes)})`)}`,
      ...shown.map((job) => pc.dim(`  ${basename(job.audioPath)}`)),
      ...(jobs.length > shown.length ? [pc.dim(`  ...and ${jobs.length - shown.length} more`)] : []),
      `${pc.bold("Output")}    ${pc.dim(outputDir)}`,
      `${pc.bold("Language")}  ${language.trim() ? c.highlight(language.trim()) : pc.dim("auto-detected")}`,
      `${pc.bold("Speech")}    ${c.highlight(getTranscriptionModelLabel(transcription.provider, transcription.model))} ${pc.dim(`(${transcription.provider})`)}`,
      `${pc.bold("Format")}    ${
        cleanup
          ? `${c.highlight(getModelLabel(cleanup.provider, cleanup.model))} ${pc.dim(`(${cleanup.provider})`)}`
          : pc.dim("skipped — raw transcript")
      }`,
      `${pc.bold("Split")}     ${
        ffmpeg ? pc.dim("ffmpeg, 15-minute segments") : pc.dim("no ffmpeg — uploaded whole")
      }`,
      "",
      pc.dim("Transcription is billed by the minute of audio, not by the file."),
    ].join("\n"),
    pc.bold("▸ Transcription summary")
  );

  const proceed = await p.confirm({ message: "Start transcription?", initialValue: true });
  if (p.isCancel(proceed) || !proceed) {
    p.log.warn(`${c.warn("⚠")} Transcription cancelled.`);
    return;
  }

  await ensureDir(outputDir);

  const converted: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const [index, job] of jobs.entries()) {
    const name = basename(job.audioPath);
    const counter = jobs.length > 1 ? `${c.highlight(`${index + 1}/${jobs.length}`)} ` : "";

    const s = p.spinner();
    s.start(`${c.dim("▸")} ${counter}${name} — preparing...`);

    try {
      const result = await convertAudioToMarkdown({
        audioPath: job.audioPath,
        outputPath: job.outputPath,
        transcription: transcription as ModelCredentials,
        cleanup: cleanup ? (cleanup as ModelCredentials) : undefined,
        language: language.trim() || undefined,
        ffmpegPath: ffmpeg,
        onStage: (stage) => {
          if (stage === "preparing") s.message(`${c.dim("▸")} ${counter}${name} — preparing...`);
          if (stage === "transcribing") s.message(`${c.dim("▸")} ${counter}${name} — transcribing...`);
          if (stage === "formatting") s.message(`${c.dim("▸")} ${counter}${name} — formatting...`);
          if (stage === "writing") s.message(`${c.dim("▸")} ${counter}${name} — writing...`);
        },
        onSegmentDone: ({ completed, total }) => {
          if (total > 1) {
            s.message(
              `${c.dim("▸")} ${counter}${name} — transcribing... ${c.highlight(`${completed}/${total}`)}`
            );
          }
        },
        onChunkDone: ({ completed, total }) => {
          if (total > 1) {
            s.message(
              `${c.dim("▸")} ${counter}${name} — formatting... ${c.highlight(`${completed}/${total}`)}`
            );
          }
        },
      });

      s.stop(`${c.success("✔")} ${name} ${pc.dim(`→ ${basename(result.outputPath)}`)}`);
      reportAudioResult(name, result);
      converted.push(result.outputPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      s.stop(`${c.error("✖")} ${name} failed.`);
      p.log.error(reason);
      failed.push({ name, reason });
    }
  }

  if (converted.length > 0) {
    p.log.success(
      `${c.success("✔")} Converted ${converted.length} of ${jobs.length} recording(s) into ${c.highlight(outputDir)}`
    );
  }

  if (failed.length > 0) {
    p.log.warn(
      `${c.warn("⚠")} ${failed.length} recording(s) failed:\n` +
      failed.map((item) => pc.dim(`  ${item.name}`)).join("\n")
    );
  }
}

export async function runToolsMenu(): Promise<void> {
  for (;;) {
    const choice = await p.select({
      message: "Tools",
      options: [
        {
          value: "media-download",
          label: "Download video or MP3",
          hint: "YouTube and 1000+ sites, via yt-dlp",
        },
        {
          value: "document-to-markdown",
          label: "Document to Markdown",
          hint: "Word, Excel, PowerPoint, EPUB, PDF — text plus figures, via markitdown + AI",
        },
        {
          value: "pdf-to-markdown",
          label: "Scanned PDF to Markdown",
          hint: "image-only PDFs, transcribed by a vision model",
        },
        {
          value: "audio-to-markdown",
          label: "Audio to Markdown",
          hint: "voice notes and recordings — MP3, OGG, Opus and more, in batch",
        },
        { value: BACK, label: "Back", hint: "return to main menu" },
      ],
    });

    if (p.isCancel(choice) || choice === BACK) return;

    if (choice === "media-download") {
      await runMediaDownloadTool();
    }

    if (choice === "document-to-markdown") {
      await runDocumentToMarkdownTool();
    }

    if (choice === "pdf-to-markdown") {
      await runPdfToMarkdownTool();
    }

    if (choice === "audio-to-markdown") {
      await runAudioToMarkdownTool();
    }
  }
}
