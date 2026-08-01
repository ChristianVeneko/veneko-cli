import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // src/templates holds template files (including their own test files) that
    // are shipped to generated projects, not tests for this CLI.
    include: ["tests/**/*.test.ts"],
  },
});
