import { readFile, writeFile, copyFile } from "fs/promises";
import { join, dirname } from "path";
import ejs from "ejs";
import { mergeJsonFile, fileExists, ensureDir, walkDir } from "../utils/fs.js";
import { getTemplatesDir } from "../utils/paths.js";
import type { FeatureManifest, FeatureName, TemplateContext } from "../types/index.js";

async function loadFeatureManifest(
  templateName: string,
  featureName: FeatureName
): Promise<FeatureManifest> {
  const templatesDir = getTemplatesDir();
  const manifestPath = join(templatesDir, templateName, "features", featureName, "feature.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as FeatureManifest;
}

async function renderFeatureOverlay(
  featureDir: string,
  outputDir: string,
  context: TemplateContext
): Promise<void> {
  const files = await walkDir(featureDir);

  for (const relPath of files) {
    if (relPath === "feature.json") continue;

    const srcPath = join(featureDir, relPath);

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

export async function applyFeature(
  templateName: string,
  featureName: FeatureName,
  projectDir: string,
  context: TemplateContext
): Promise<string | undefined> {
  const manifest = await loadFeatureManifest(templateName, featureName);
  const templatesDir = getTemplatesDir();
  const featureDir = join(templatesDir, templateName, "features", featureName);

  await renderFeatureOverlay(featureDir, projectDir, context);

  const pkgJsonPath = join(projectDir, "package.json");
  if (await fileExists(pkgJsonPath)) {
    const updates: Record<string, unknown> = {};

    if (Object.keys(manifest.dependencies).length > 0) {
      updates.dependencies = manifest.dependencies;
    }

    if (Object.keys(manifest.devDependencies).length > 0) {
      updates.devDependencies = manifest.devDependencies;
    }

    if (Object.keys(manifest.scripts).length > 0) {
      updates.scripts = manifest.scripts;
    }

    if (Object.keys(updates).length > 0) {
      await mergeJsonFile(pkgJsonPath, updates);
    }
  }

  return manifest.postInstallMessage;
}

export async function featureExists(
  templateName: string,
  featureName: FeatureName
): Promise<boolean> {
  const templatesDir = getTemplatesDir();
  const manifestPath = join(templatesDir, templateName, "features", featureName, "feature.json");
  return fileExists(manifestPath);
}

export async function loadTemplateManifest(templateName: string) {
  const templatesDir = getTemplatesDir();
  const manifestPath = join(templatesDir, templateName, "template.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as { supportedFeatures: FeatureName[]; displayName: string };
}
