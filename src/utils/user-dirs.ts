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

function userDirCandidates(): DestinationCandidate[] {
  const home = homedir();

  return [
    {
      value: "desktop",
      label: "Desktop",
      // OneDrive redirects these folders on many Windows installs.
      candidates: [join(home, "Desktop"), join(home, "OneDrive", "Desktop")],
    },
    {
      value: "downloads",
      label: "Downloads",
      candidates: [join(home, "Downloads"), join(home, "OneDrive", "Downloads")],
    },
    {
      value: "documents",
      label: "Documents",
      candidates: [join(home, "Documents"), join(home, "OneDrive", "Documents")],
    },
  ];
}

/**
 * Returns the folders a user can save tool output to: the current working
 * directory plus the standard user folders that actually exist on this machine.
 */
export async function listOutputDestinations(): Promise<OutputDestination[]> {
  const destinations: OutputDestination[] = [
    { value: "cwd", label: "Current folder", path: process.cwd() },
  ];

  for (const candidate of userDirCandidates()) {
    for (const path of candidate.candidates) {
      if (await fileExists(path)) {
        destinations.push({ value: candidate.value, label: candidate.label, path });
        break;
      }
    }
  }

  return destinations;
}
