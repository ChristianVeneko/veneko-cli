import { describe, expect, it } from "vitest";
import { isAbsolute } from "path";
import { listOutputDestinations } from "../src/utils/user-dirs.js";

describe("listOutputDestinations", () => {
  it("always offers the current working directory first", async () => {
    const destinations = await listOutputDestinations();
    expect(destinations[0]).toEqual({
      value: "cwd",
      label: "Current folder",
      path: process.cwd(),
    });
  });

  it("returns absolute paths for every destination", async () => {
    for (const destination of await listOutputDestinations()) {
      expect(isAbsolute(destination.path)).toBe(true);
    }
  });

  it("does not hardcode a user, resolving paths under the current home directory", async () => {
    const { homedir } = await import("os");
    const userDirs = (await listOutputDestinations()).filter((d) => d.value !== "cwd");

    for (const destination of userDirs) {
      expect(destination.path.startsWith(homedir())).toBe(true);
    }
  });

  it("only offers folders that exist on this machine", async () => {
    const { fileExists } = await import("../src/utils/fs.js");
    for (const destination of await listOutputDestinations()) {
      expect(await fileExists(destination.path)).toBe(true);
    }
  });

  it("never lists the same destination twice", async () => {
    const values = (await listOutputDestinations()).map((d) => d.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
