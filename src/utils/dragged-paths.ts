import { platform } from "os";
import { isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";

export interface SplitOptions {
  /**
   * Whether a backslash escapes the character after it. True everywhere except
   * Windows, where the backslash is the path separator and un-escaping it would
   * turn C:\Users\chris into C:Userschris.
   */
  unescapeBackslashes?: boolean;
}

/**
 * Splits what a terminal writes when files are dropped onto it into separate
 * paths.
 *
 * Every terminal quotes differently. Windows Terminal wraps a path containing
 * spaces in double quotes, macOS Terminal escapes each space with a backslash,
 * and some Linux desktops paste a file:// URI instead of a path. All three
 * forms have to survive, because the user never sees which one their terminal
 * chose.
 *
 * An unquoted, unescaped path with spaces in it cannot be told apart from two
 * paths — that one is unrecoverable here, and shows up to the caller as a file
 * that does not exist.
 */
export function splitDraggedInput(input: string, options: SplitOptions = {}): string[] {
  const unescape = options.unescapeBackslashes ?? platform() !== "win32";
  const tokens: string[] = [];

  let current = "";
  let quote: '"' | "'" | null = null;

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    // A backslash inside single quotes is literal, the same way a shell reads it.
    if (unescape && char === "\\" && quote !== "'" && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return tokens;
}

/** Turns one token into an absolute path, decoding a file:// URI if that is what it is. */
export function cleanDraggedPath(token: string): string {
  const trimmed = token.trim();

  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      // Not a URI this platform can resolve — fall through and treat it as a path.
    }
  }

  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

/**
 * Parses a line of dragged files into absolute paths, in the order they were
 * dropped and without repeats — dragging the same file twice is a slip, not a
 * request to convert it twice.
 */
export function parseDraggedPaths(input: string, options: SplitOptions = {}): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const token of splitDraggedInput(input, options)) {
    const path = cleanDraggedPath(token);
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  return paths;
}
