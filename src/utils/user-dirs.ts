import { homedir } from "os";
import { join } from "path";
import { fileExists } from "./fs.js";

export interface OutputDestination {
  value: string;
  label: string;
  path: string;
}

interface DestinationCandidate {
  value: string;
  label: string;
  /** Checked in order; the first existing directory wins. */
  candidates: string[];
}

/** OneDrive redirects these folders on many Windows installs. */
function userDir(value: string, label: string, folder: string): DestinationCandidate {
  const home = homedir();
  return {
    value,
    label,
    candidates: [join(home, folder), join(home, "OneDrive", folder)],
  };
}

function documentCandidates(): DestinationCandidate[] {
  return [
    userDir("desktop", "Desktop", "Desktop"),
    userDir("downloads", "Downloads", "Downloads"),
    userDir("documents", "Documents", "Documents"),
  ];
}

function mediaCandidates(): DestinationCandidate[] {
  return [
    userDir("downloads", "Downloads", "Downloads"),
    userDir("videos", "Videos", "Videos"),
    userDir("music", "Music", "Music"),
    userDir("desktop", "Desktop", "Desktop"),
  ];
}

async function resolveDestinations(
  candidates: DestinationCandidate[]
): Promise<OutputDestination[]> {
  const destinations: OutputDestination[] = [
    { value: "cwd", label: "Current folder", path: process.cwd() },
  ];

  for (const candidate of candidates) {
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
  return resolveDestinations(documentCandidates());
}

/** Same idea, ordered for downloads: Videos and Music instead of Documents. */
export function listMediaDestinations(): Promise<OutputDestination[]> {
  return resolveDestinations(mediaCandidates());
}
