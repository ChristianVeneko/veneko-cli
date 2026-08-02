import { readFileSync } from "fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Node 22, not 20: pdfjs-dist calls ArrayBuffer.prototype.transferToFixedLength,
  // which landed in Node 21, so the scanned-PDF tool throws on anything older.
  // Node 20 reached end of life in April 2026 anyway.
  target: "node22",
  clean: true,
  splitting: false,
  // package.json is not shipped next to the bundle in every install layout, so
  // the version is baked in at build time instead of read at runtime.
  define: {
    __VENEKO_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
