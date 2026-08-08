import { describe, expect, it } from "vitest";
import { pathToFileURL } from "url";
import { isAbsolute, resolve } from "path";
import {
  cleanDraggedPath,
  parseDraggedPaths,
  splitDraggedInput,
} from "../src/utils/dragged-paths.js";

/** The two escaping conventions, pinned so neither platform is only tested by CI. */
const posix = { unescapeBackslashes: true };
const windows = { unescapeBackslashes: false };

describe("splitDraggedInput", () => {
  it("splits plain paths on whitespace", () => {
    expect(splitDraggedInput("/a/one.mp3 /a/two.ogg", posix)).toEqual([
      "/a/one.mp3",
      "/a/two.ogg",
    ]);
  });

  it("keeps a double-quoted path with spaces in one piece", () => {
    expect(splitDraggedInput('"C:\\Users\\chris\\voice note.ogg" C:\\b.mp3', windows)).toEqual([
      "C:\\Users\\chris\\voice note.ogg",
      "C:\\b.mp3",
    ]);
  });

  it("keeps a single-quoted path with spaces in one piece", () => {
    expect(splitDraggedInput("'/home/me/voice note.ogg'", posix)).toEqual([
      "/home/me/voice note.ogg",
    ]);
  });

  it("honours backslash-escaped spaces the way macOS Terminal writes them", () => {
    expect(splitDraggedInput("/Users/me/voice\\ note.ogg /Users/me/b.mp3", posix)).toEqual([
      "/Users/me/voice note.ogg",
      "/Users/me/b.mp3",
    ]);
  });

  it("never un-escapes on Windows, where the backslash is the separator", () => {
    expect(splitDraggedInput("C:\\Users\\chris\\note.ogg", windows)).toEqual([
      "C:\\Users\\chris\\note.ogg",
    ]);
  });

  it("leaves a backslash alone inside single quotes", () => {
    expect(splitDraggedInput("'/home/me/a\\b.mp3'", posix)).toEqual(["/home/me/a\\b.mp3"]);
  });

  it("collapses runs of whitespace, including newlines", () => {
    expect(splitDraggedInput("  /a.mp3 \n\t /b.ogg  ", posix)).toEqual(["/a.mp3", "/b.ogg"]);
  });

  it("returns nothing for an empty line", () => {
    expect(splitDraggedInput("   ", posix)).toEqual([]);
  });

  it("handles a quote that was never closed rather than dropping the path", () => {
    expect(splitDraggedInput('"/a/note one.mp3', posix)).toEqual(["/a/note one.mp3"]);
  });
});

describe("cleanDraggedPath", () => {
  it("decodes a file:// URI, which is what some Linux desktops paste", () => {
    const original = resolve("voice note.ogg");
    const uri = pathToFileURL(original).href;

    expect(uri).toContain("%20");
    expect(cleanDraggedPath(uri)).toBe(original);
  });

  it("resolves a relative path against the working directory", () => {
    expect(isAbsolute(cleanDraggedPath("./note.mp3"))).toBe(true);
  });

  it("leaves an absolute path untouched", () => {
    const absolute = process.cwd();
    expect(cleanDraggedPath(absolute)).toBe(absolute);
  });
});

describe("parseDraggedPaths", () => {
  it("drops a file dragged in twice", () => {
    const paths = parseDraggedPaths("/a/one.mp3 /a/two.ogg /a/one.mp3", posix);
    expect(paths).toHaveLength(2);
  });

  it("keeps the order the files were dropped in", () => {
    const paths = parseDraggedPaths("/a/z.mp3 /a/a.mp3", posix);
    expect(paths[0].endsWith("z.mp3")).toBe(true);
    expect(paths[1].endsWith("a.mp3")).toBe(true);
  });
});
