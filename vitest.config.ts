import { readFileSync } from "fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  version: string;
};

export default defineConfig({
  // Mirrors the tsup build: the version constant is injected, not imported, so
  // tests that touch it need the same substitution.
  define: {
    __VENEKO_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // src/templates holds template files (including their own test files) that
    // are shipped to generated projects, not tests for this CLI.
    include: ["tests/**/*.test.ts"],
  },
});
