import { REPO_NAME, REPO_OWNER } from "./version.js";

const RELEASES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface LatestRelease {
  /** Tag as published, e.g. `v1.2.0`. */
  tag: string;
  /** Tag without the leading `v`, for comparing against the running version. */
  version: string;
  url: string;
  publishedAt: string | null;
  notes: string | null;
}

export class ReleaseLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseLookupError";
  }
}

/**
 * Reads the latest published release straight from the GitHub API.
 *
 * Unauthenticated calls are rate-limited to 60 per hour per IP, which is far
 * more than an update check needs, so no token is required — and asking for one
 * to check for updates would be absurd.
 */
export async function fetchLatestRelease(
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<LatestRelease> {
  let response: Response;

  try {
    response = await fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${REPO_NAME}-cli`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
    throw new ReleaseLookupError(
      `Could not reach GitHub to check for updates (request ${reason}). Check your connection.`
    );
  }

  if (response.status === 404) {
    throw new ReleaseLookupError(
      "This repository has no published releases yet, so there is nothing to update to."
    );
  }
  if (response.status === 403) {
    throw new ReleaseLookupError(
      "GitHub rate-limited the update check (HTTP 403). Try again in a few minutes."
    );
  }
  if (!response.ok) {
    throw new ReleaseLookupError(`GitHub returned HTTP ${response.status} for the update check.`);
  }

  return parseRelease(await response.json());
}

/** Split out from the request so the shape handling can be tested on its own. */
export function parseRelease(payload: unknown): LatestRelease {
  const raw = payload as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    body?: unknown;
  };

  if (typeof raw?.tag_name !== "string" || raw.tag_name.length === 0) {
    throw new ReleaseLookupError("GitHub returned a release veneko could not read.");
  }

  return {
    tag: raw.tag_name,
    version: raw.tag_name.replace(/^v/, ""),
    url: typeof raw.html_url === "string" ? raw.html_url : `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
    notes: typeof raw.body === "string" && raw.body.trim().length > 0 ? raw.body.trim() : null,
  };
}
