import { readFileSync } from "fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Node 20 is the oldest release still receiving security fixes, and it is
  // what the system package of most distros installs today.
  target: "node20",
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
