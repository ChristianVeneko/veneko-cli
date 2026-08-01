import { readFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { fileExists } from "./fs.js";

export interface OutputDestination {
  value: string;
  label: string;
  path: string;
}

/** The user folders veneko knows how to offer as a destination. */
type UserDirKey = "desktop" | "downloads" | "documents" | "videos" | "music";

interface DestinationCandidate {
  value: UserDirKey;
  label: string;
  /** Checked in order; the first existing directory wins. */
  candidates: string[];
}

/**
 * The folder name each platform actually uses on disk. macOS calls the video
 * folder "Movies", not "Videos" — asking for the wrong one silently drops the
 * destination from the list instead of failing, so it has to be right per OS.
 *
 * On Linux the names are the XDG defaults, which is only the fallback: a
 * localized desktop is read from user-dirs.dirs below.
 */
const FOLDER_NAMES: Record<UserDirKey, string> = {
  desktop: "Desktop",
  downloads: "Downloads",
  documents: "Documents",
  videos: "Videos",
  music: "Music",
};

const MACOS_FOLDER_NAMES: Partial<Record<UserDirKey, string>> = {
  videos: "Movies",
};

function folderName(key: UserDirKey): string {
  if (platform() === "darwin") return MACOS_FOLDER_NAMES[key] ?? FOLDER_NAMES[key];
  return FOLDER_NAMES[key];
}

/** XDG variable that holds each folder, for Linux desktops in other languages. */
const XDG_VARIABLES: Record<UserDirKey, string> = {
  desktop: "XDG_DESKTOP_DIR",
  downloads: "XDG_DOWNLOAD_DIR",
  documents: "XDG_DOCUMENTS_DIR",
  videos: "XDG_VIDEOS_DIR",
  music: "XDG_MUSIC_DIR",
};

/**
 * Reads ~/.config/user-dirs.dirs, which is where a Linux desktop records the
 * real — often translated — folder names, e.g. `XDG_DESKTOP_DIR="$HOME/Escritorio"`.
 * Returns an empty map on any other platform or when the file is absent.
 */
async function readXdgUserDirs(): Promise<Partial<Record<UserDirKey, string>>> {
  if (platform() !== "linux") return {};

  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");

  let contents: string;
  try {
    contents = await readFile(join(configHome, "user-dirs.dirs"), "utf-8");
  } catch {
    return {};
  }

  const resolved: Partial<Record<UserDirKey, string>> = {};

  for (const [key, variable] of Object.entries(XDG_VARIABLES) as [UserDirKey, string][]) {
    const match = new RegExp(`^\\s*${variable}\\s*=\\s*"?(.+?)"?\\s*$`, "m").exec(contents);
    if (!match) continue;

    const value = match[1].replace(/^\$HOME/, home);
    // A relative value would resolve against the process cwd, not the home
    // directory, so anything that is not already absolute is skipped.
    if (value.startsWith(home) || value.startsWith("/")) {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Builds the lookup list for one folder. OneDrive redirects Desktop, Documents
 * and Pictures on many Windows installs, so the redirected copy is tried too.
 */
function candidatesFor(
  key: UserDirKey,
  label: string,
  xdg: Partial<Record<UserDirKey, string>>
): DestinationCandidate {
  const home = homedir();
  const folder = folderName(key);
  const candidates: string[] = [];

  const fromXdg = xdg[key];
  if (fromXdg) candidates.push(fromXdg);

  candidates.push(join(home, folder));
  if (platform() === "win32") candidates.push(join(home, "OneDrive", folder));

  return { value: key, label, candidates };
}

async function resolveDestinations(
  wanted: [UserDirKey, string][]
): Promise<OutputDestination[]> {
  const destinations: OutputDestination[] = [
    { value: "cwd", label: "Current folder", path: process.cwd() },
  ];

  const xdg = await readXdgUserDirs();

  for (const [key, label] of wanted) {
    const candidate = candidatesFor(key, label, xdg);
    for (const path of candidate.candidates) {
      if (await fileExists(path)) {
        destinations.push({ value: candidate.value, label: candidate.label, path });
        break;
      }
    }
  }

  return destinations;
}

/**
 * Returns the folders a user can save tool output to: the current working
 * directory plus the standard user folders that actually exist on this machine.
 */
export function listOutputDestinations(): Promise<OutputDestination[]> {
  return resolveDestinations([
    ["desktop", "Desktop"],
    ["downloads", "Downloads"],
    ["documents", "Documents"],
  ]);
}

/** Same idea, ordered for downloads: video and music folders instead of Documents. */
export function listMediaDestinations(): Promise<OutputDestination[]> {
  return resolveDestinations([
    ["downloads", "Downloads"],
    ["videos", platform() === "darwin" ? "Movies" : "Videos"],
    ["music", "Music"],
    ["desktop", "Desktop"],
  ]);
}
