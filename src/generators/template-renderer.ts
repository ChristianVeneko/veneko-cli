import { readFile, writeFile, copyFile } from "fs/promises";
import { join, dirname } from "path";
import ejs from "ejs";
import { walkDir, ensureDir } from "../utils/fs.js";
import type { TemplateContext } from "../types/index.js";

export async function renderTemplate(
  templateDir: string,
  outputDir: string,
  context: TemplateContext
): Promise<void> {
  const files = await walkDir(templateDir);

  for (const relPath of files) {
    const srcPath = join(templateDir, relPath);

    if (relPath.endsWith(".ejs")) {
      const content = await readFile(srcPath, "utf-8");
      const rendered = ejs.render(content, context);
      const destPath = join(outputDir, relPath.replace(/\.ejs$/, ""));
      await ensureDir(dirname(destPath));
      await writeFile(destPath, rendered, "utf-8");
    } else {
      const destPath = join(outputDir, relPath);
      await ensureDir(dirname(destPath));
      await copyFile(srcPath, destPath);
    }
  }
}
