import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import * as p from "@clack/prompts";
import { getTemplatesDir } from "../utils/paths.js";
import { ensureDir } from "../utils/fs.js";
import { install } from "../utils/package-manager.js";
import { initGitRepo } from "../utils/git.js";
import { renderTemplate } from "./template-renderer.js";
import { generateClaudeMd } from "./claude-md-generator.js";
import { toKebabCase, toPascalCase, toCamelCase } from "../utils/name-utils.js";
import { applyFeature } from "./feature-generator.js";
import type { CreateConfig, TemplateManifest, TemplateContext, FeatureName } from "../types/index.js";

const COMMON_DEV_DEPS: Record<string, string> = {
  "@biomejs/biome": "^1.9.0",
  husky: "^9.1.0",
  vitest: "^3.2.0",
};

const COMMON_SCRIPTS: Record<string, string> = {
  lint: "biome check .",
  "lint:fix": "biome check --write .",
  format: "biome format --write .",
  prepare: "husky",
  test: "vitest run",
};

const BIOME_CONFIG = {
  $schema: "https://biomejs.dev/schemas/1.9.0/schema.json",
  organizeImports: { enabled: true },
  linter: {
    enabled: true,
    rules: {
      recommended: true,
    },
  },
  formatter: {
    enabled: true,
    indentStyle: "space",
    indentWidth: 2,
    lineWidth: 100,
  },
  javascript: {
    formatter: {
      quoteStyle: "double",
      trailingCommas: "es5",
    },
  },
};

async function loadManifest(templateName: string): Promise<TemplateManifest> {
  const templatesDir = getTemplatesDir();
  const manifestPath = join(templatesDir, templateName, "template.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as TemplateManifest;
}

function buildPackageJson(
  config: CreateConfig,
  manifest: TemplateManifest
): Record<string, unknown> {
  return {
    name: config.projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      ...manifest.scripts,
      ...COMMON_SCRIPTS,
    },
    dependencies: {
      ...manifest.dependencies,
    },
    devDependencies: {
      ...manifest.devDependencies,
      ...COMMON_DEV_DEPS,
    },
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function writeHuskyPreCommit(
  outputDir: string,
  pm: string
): Promise<void> {
  const huskyDir = join(outputDir, ".husky");
  await ensureDir(huskyDir);
  const script = `${pm} run lint\n`;
  await writeFile(join(huskyDir, "pre-commit"), script, "utf-8");
}

export async function generateProject(config: CreateConfig): Promise<void> {
  const { projectName, template, outputDir, packageManager, initGit, generateClaudeMd: genClaudeMd } = config;

  const manifest = await loadManifest(template);

  const context: TemplateContext = {
    projectName,
    projectNameKebab: toKebabCase(projectName),
    projectNamePascal: toPascalCase(projectName),
    projectNameCamel: toCamelCase(projectName),
    database: config.database,
    packageManager,
    year: new Date().getFullYear(),
  };

  await ensureDir(outputDir);

  const templatesDir = getTemplatesDir();
  const baseDir = join(templatesDir, template, "base");

  await renderTemplate(baseDir, outputDir, context);

  if (config.database !== "none") {
    const featureName = `db-${config.database}` as FeatureName;
    try {
      await applyFeature(template, featureName, outputDir, context);
    } catch {
      p.log.warn(`DB feature overlay for "${config.database}" not found — skipping.`);
    }
  }

  const pkgJson = buildPackageJson(config, manifest);
  await writeJson(join(outputDir, "package.json"), pkgJson);

  await writeJson(join(outputDir, "biome.json"), BIOME_CONFIG);

  await writeHuskyPreCommit(outputDir, packageManager);

  if (genClaudeMd) {
    const claudeMdContent = generateClaudeMd(config, manifest);
    await writeFile(join(outputDir, "CLAUDE.md"), claudeMdContent, "utf-8");
  }

  const s = p.spinner();
  s.start(`Installing dependencies with ${packageManager}...`);
  try {
    await install(packageManager, outputDir);
    s.stop("Dependencies installed.");
  } catch {
    s.stop("Install failed — run the install command manually.");
  }

  if (initGit) {
    const gs = p.spinner();
    gs.start("Initializing git repository...");
    try {
      await initGitRepo(outputDir, true);
      gs.stop("Git repository initialized.");
    } catch {
      gs.stop("Git init failed — run git init manually.");
    }
  }
}
