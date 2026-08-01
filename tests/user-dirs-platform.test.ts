import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These cover the folder names veneko must get right per platform. They cannot
 * run against the real filesystem — the whole point is asserting what macOS and
 * Linux look for on a machine that is neither — so os and fs are both faked.
 */

const HOME = "/home/tester";

/**
 * Folder names are assembled with path.join, so the separator is whatever the
 * machine running the tests uses. XDG values are the exception: they are read
 * verbatim from a config file, so those stay forward-slashed.
 */
const under = (...parts: string[]) => join(HOME, ...parts);

let currentPlatform: NodeJS.Platform = "linux";
let existingPaths: Set<string>;
let xdgFile: string | null;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => HOME,
    platform: () => currentPlatform,
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    stat: async (path: string) => {
      if (existingPaths.has(path)) return {} as never;
      throw new Error(`ENOENT: ${path}`);
    },
    readFile: async (path: string) => {
      if (xdgFile !== null && String(path).endsWith("user-dirs.dirs")) return xdgFile;
      throw new Error(`ENOENT: ${path}`);
    },
  };
});

async function load() {
  vi.resetModules();
  return import("../src/utils/user-dirs.js");
}

beforeEach(() => {
  existingPaths = new Set();
  xdgFile = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("media destinations on macOS", () => {
  beforeEach(() => {
    currentPlatform = "darwin";
  });

  it("looks for Movies, which is what macOS actually calls the video folder", async () => {
    existingPaths.add(under("Movies"));
    existingPaths.add(under("Downloads"));

    const { listMediaDestinations } = await load();
    const destinations = await listMediaDestinations();
    const videos = destinations.find((d) => d.value === "videos");

    expect(videos?.path).toBe(under("Movies"));
    expect(videos?.label).toBe("Movies");
  });

  it("does not offer a Videos folder that does not exist on macOS", async () => {
    existingPaths.add(under("Videos"));

    const { listMediaDestinations } = await load();
    const destinations = await listMediaDestinations();

    expect(destinations.some((d) => d.value === "videos")).toBe(false);
  });

  it("does not look inside OneDrive, which is a Windows redirect", async () => {
    existingPaths.add(under("OneDrive", "Desktop"));

    const { listOutputDestinations } = await load();
    const destinations = await listOutputDestinations();

    expect(destinations.some((d) => d.value === "desktop")).toBe(false);
  });
});

describe("destinations on Linux", () => {
  beforeEach(() => {
    currentPlatform = "linux";
  });

  it("uses the XDG names, so a Spanish desktop gets Escritorio", async () => {
    xdgFile = [
      'XDG_DESKTOP_DIR="$HOME/Escritorio"',
      'XDG_DOWNLOAD_DIR="$HOME/Descargas"',
    ].join("\n");
    existingPaths.add(`${HOME}/Escritorio`);
    existingPaths.add(`${HOME}/Descargas`);

    const { listOutputDestinations } = await load();
    const destinations = await listOutputDestinations();

    expect(destinations.find((d) => d.value === "desktop")?.path).toBe(`${HOME}/Escritorio`);
    expect(destinations.find((d) => d.value === "downloads")?.path).toBe(`${HOME}/Descargas`);
  });

  it("falls back to the English names when there is no XDG configuration", async () => {
    existingPaths.add(under("Desktop"));
    existingPaths.add(under("Videos"));

    const { listOutputDestinations, listMediaDestinations } = await load();

    expect((await listOutputDestinations()).find((d) => d.value === "desktop")?.path).toBe(
      under("Desktop")
    );
    expect((await listMediaDestinations()).find((d) => d.value === "videos")?.path).toBe(
      under("Videos")
    );
  });

  it("ignores a relative XDG value, which would resolve against the cwd", async () => {
    xdgFile = 'XDG_DESKTOP_DIR="Escritorio"';
    existingPaths.add(under("Desktop"));

    const { listOutputDestinations } = await load();
    const destinations = await listOutputDestinations();

    expect(destinations.find((d) => d.value === "desktop")?.path).toBe(under("Desktop"));
  });
});

describe("destinations on Windows", () => {
  beforeEach(() => {
    currentPlatform = "win32";
  });

  it("falls back to the OneDrive copy when the folder was redirected", async () => {
    existingPaths.add(under("OneDrive", "Desktop"));

    const { listOutputDestinations } = await load();
    const destinations = await listOutputDestinations();

    expect(destinations.find((d) => d.value === "desktop")?.path).toBe(under("OneDrive", "Desktop"));
  });

  it("prefers the local folder over the OneDrive one", async () => {
    existingPaths.add(under("Desktop"));
    existingPaths.add(under("OneDrive", "Desktop"));

    const { listOutputDestinations } = await load();
    const destinations = await listOutputDestinations();

    expect(destinations.find((d) => d.value === "desktop")?.path).toBe(under("Desktop"));
  });
});
