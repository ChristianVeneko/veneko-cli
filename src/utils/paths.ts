import { join } from "path";
import { fileURLToPath } from "url";

export function getTemplatesDir(): string {
  // tsup bundles everything into dist/index.js
  // templates are copied to dist/templates/ by postbuild
  const distDir = fileURLToPath(new URL(".", import.meta.url));
  return join(distDir, "templates");
}
