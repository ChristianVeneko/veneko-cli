import { describe, expect, it } from "vitest";
import { parseRelease, ReleaseLookupError } from "../src/utils/github.js";

describe("parseRelease", () => {
  it("reads the tag, url and notes of a release", () => {
    const release = parseRelease({
      tag_name: "v1.4.0",
      html_url: "https://github.com/ChristianVeneko/veneko-cli/releases/tag/v1.4.0",
      published_at: "2026-01-15T10:00:00Z",
      body: "- Added the doctor command\n",
    });

    expect(release.tag).toBe("v1.4.0");
    expect(release.url).toContain("/releases/tag/v1.4.0");
    expect(release.publishedAt).toBe("2026-01-15T10:00:00Z");
    expect(release.notes).toBe("- Added the doctor command");
  });

  it("strips the leading v so the tag can be compared to package.json", () => {
    expect(parseRelease({ tag_name: "v2.0.1" }).version).toBe("2.0.1");
    expect(parseRelease({ tag_name: "2.0.1" }).version).toBe("2.0.1");
  });

  it("falls back to the releases page when the payload has no url", () => {
    expect(parseRelease({ tag_name: "v1.0.0" }).url).toContain("/releases");
  });

  it("treats empty release notes as absent", () => {
    expect(parseRelease({ tag_name: "v1.0.0", body: "   \n  " }).notes).toBeNull();
  });

  it("rejects a payload without a tag instead of inventing one", () => {
    expect(() => parseRelease({})).toThrow(ReleaseLookupError);
    expect(() => parseRelease({ tag_name: "" })).toThrow(ReleaseLookupError);
    expect(() => parseRelease(null)).toThrow(ReleaseLookupError);
  });
});
