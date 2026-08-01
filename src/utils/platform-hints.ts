import { platform } from "os";

export type OptionalTool = "node" | "python" | "pipx" | "markitdown" | "yt-dlp" | "ffmpeg" | "git";

/**
 * The command that installs each dependency on the current OS.
 *
 * Kept in one table instead of inline strings so a Linux user is never told to
 * run `brew install` — a wrong hint is worse than no hint, because it sends
 * people installing a package manager they did not need.
 */
const HINTS: Record<OptionalTool, { darwin: string; linux: string; win32: string }> = {
  node: {
    darwin: "brew install node",
    linux: "sudo apt install nodejs npm    # or your distro's equivalent",
    win32: "winget install OpenJS.NodeJS.LTS",
  },
  git: {
    darwin: "xcode-select --install",
    linux: "sudo apt install git",
    win32: "winget install Git.Git",
  },
  python: {
    darwin: "brew install python",
    linux: "sudo apt install python3 python3-pip python3-venv",
    win32: "winget install Python.Python.3.12",
  },
  pipx: {
    darwin: "brew install pipx && pipx ensurepath",
    linux: "sudo apt install pipx && pipx ensurepath",
    win32: "py -m pip install --user pipx && py -m pipx ensurepath",
  },
  markitdown: {
    darwin: "pipx install 'markitdown[all]'",
    linux: "pipx install 'markitdown[all]'",
    win32: 'pipx install "markitdown[all]"',
  },
  "yt-dlp": {
    darwin: "brew install yt-dlp",
    linux: "pipx install yt-dlp",
    win32: "winget install yt-dlp.yt-dlp",
  },
  ffmpeg: {
    darwin: "brew install ffmpeg",
    linux: "sudo apt install ffmpeg",
    win32: "winget install Gyan.FFmpeg",
  },
};

export function installHint(tool: OptionalTool): string {
  const entry = HINTS[tool];
  const current = platform();

  if (current === "darwin") return entry.darwin;
  if (current === "win32") return entry.win32;
  return entry.linux;
}

/** Human name of the current platform, for messages. */
export function platformLabel(): string {
  const current = platform();
  if (current === "darwin") return "macOS";
  if (current === "win32") return "Windows";
  if (current === "linux") return "Linux";
  return current;
}
