import { postWithRetry, textFromGeminiShape } from "./client.js";
import type { ProviderId } from "../config/providers.js";

export interface AudioSupport {
  /** Largest audio payload the provider accepts in one request, in bytes. */
  maxBytes: number;
  /** MIME types the provider decodes. Anything else has to be transcoded. */
  mimeTypes: string[];
}

/**
 * Only two of the four providers take audio at all: Anthropic and xAI have no
 * audio input, so they are absent from this map rather than listed as unusable.
 */
const AUDIO_SUPPORT: Partial<Record<ProviderId, AudioSupport>> = {
  openai: {
    // The documented cap is 25 MB; the margin covers the multipart envelope.
    maxBytes: 24 * 1024 * 1024,
    mimeTypes: [
      "audio/mpeg",
      "audio/ogg",
      "audio/mp4",
      "audio/wav",
      "audio/x-wav",
      "audio/flac",
      "audio/webm",
    ],
  },
  google: {
    // Gemini carries the audio base64-encoded inside a 20 MB JSON request, and
    // base64 costs a third more than the bytes it encodes.
    maxBytes: 14 * 1024 * 1024,
    mimeTypes: [
      "audio/mpeg",
      "audio/mp3",
      "audio/ogg",
      "audio/wav",
      "audio/flac",
      "audio/aac",
      "audio/aiff",
    ],
  },
};

/** Returns null for a provider that cannot transcribe audio at all. */
export function audioSupport(provider: ProviderId): AudioSupport | null {
  return AUDIO_SUPPORT[provider] ?? null;
}

export function supportsAudio(provider: ProviderId): boolean {
  return AUDIO_SUPPORT[provider] !== undefined;
}

/**
 * Gemini is a chat model, so it has to be told to transcribe rather than to
 * answer. The rules are the ones a speech model applies implicitly: every word,
 * nothing added, and an explicit marker for what cannot be made out.
 */
export function buildGeminiTranscriptionPrompt(language?: string): string {
  const lines = [
    "Transcribe this audio recording word for word.",
    "- Write only what is actually said, in the language it is spoken in.",
    "- Do not summarize, translate, comment on or add anything.",
    "- Write [inaudible] for any passage you cannot make out.",
    "- Return only the transcript, with no preamble.",
  ];

  if (language && language.length > 0) {
    lines.push(`The audio is spoken in ${language}.`);
  }

  return lines.join("\n");
}

export interface TranscribeAudioRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  audio: Uint8Array;
  /** File name sent with the upload; the provider reads the format from it. */
  fileName: string;
  mimeType: string;
  /** ISO-639-1 hint such as "es". Omit to let the model detect the language. */
  language?: string;
  timeoutMs?: number;
}

/** Audio requests upload a file and then wait on a slow model, so 120 s is not enough. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * A 15-minute segment is roughly 2,500 spoken words. 8,192 tokens leaves room
 * for a dense speaker and is the ceiling the older Gemini models accept.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 8192;

/** Sends one audio payload to the provider and returns the raw transcript. */
export async function transcribeAudio(req: TranscribeAudioRequest): Promise<string> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (req.provider === "openai") {
    const form = new FormData();
    form.append("file", new Blob([req.audio], { type: req.mimeType }), req.fileName);
    form.append("model", req.model);
    form.append("response_format", "json");
    if (req.language && req.language.length > 0) form.append("language", req.language);

    const payload = await postWithRetry({
      provider: "openai",
      url: "https://api.openai.com/v1/audio/transcriptions",
      // Content-Type is deliberately absent: fetch has to set the multipart
      // boundary itself, and any value here would overwrite it.
      headers: { Authorization: `Bearer ${req.apiKey}` },
      body: form,
      timeoutMs,
    });

    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? text.trim() : "";
  }

  if (req.provider === "google") {
    const payload = await postWithRetry({
      provider: "google",
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": req.apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildGeminiTranscriptionPrompt(req.language) },
              {
                inline_data: {
                  mime_type: req.mimeType,
                  data: Buffer.from(req.audio).toString("base64"),
                },
              },
            ],
          },
        ],
        // Transcription is the one task where creativity is a defect.
        generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, temperature: 0 },
      }),
      timeoutMs,
    });

    return textFromGeminiShape(payload).trim();
  }

  throw new Error(`${req.provider} cannot transcribe audio.`);
}
