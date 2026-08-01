import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getTemplatesDir } from "../utils/paths.js";
import { ensureDir } from "../utils/fs.js";
import { install } from "../utils/package-manager.js";
import { initGitRepo } from "../utils/git.js";
import { renderTemplate } from "./template-renderer.js";
import { generateClaudeMd } from "./claude-md-generator.js";
import { toKebabCase, toPascalCase, toCamelCase } from "../utils/name-utils.js";
import { applyFeature } from "./feature-generator.js";
import { c } from "../utils/logger.js";
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

const ESM_TEMPLATES = new Set(["nextjs", "nuxt", "vite", "vue", "astro"]);

function buildPackageJson(
  config: CreateConfig,
  manifest: TemplateManifest
): Record<string, unknown> {
  const pkg: Record<string, unknown> = {
    name: config.projectName,
    version: "0.1.0",
    private: true,
  };

  if (ESM_TEMPLATES.has(config.template)) {
    pkg.type = "module";
  }

  return {
    ...pkg,
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

  const pkgJson = buildPackageJson(config, manifest);
  await writeJson(join(outputDir, "package.json"), pkgJson);

  let dbPostInstallMessage: string | undefined;
  if (config.database !== "none") {
    const featureName = `db-${config.database}` as FeatureName;
    try {
      dbPostInstallMessage = await applyFeature(template, featureName, outputDir, context);
    } catch {
      p.log.warn(
        `${c.warn("⚠")} DB feature overlay for ${c.highlight(config.database)} not found — skipping.`
      );
    }
  }

  await writeJson(join(outputDir, "biome.json"), BIOME_CONFIG);

  await writeHuskyPreCommit(outputDir, packageManager);

  if (genClaudeMd) {
    const claudeMdContent = generateClaudeMd(config, manifest);
    await writeFile(join(outputDir, "CLAUDE.md"), claudeMdContent, "utf-8");
  }

  const s = p.spinner();
  s.start(`${c.dim("▸")} Installing dependencies with ${c.highlight(packageManager)}...`);
  try {
    await install(packageManager, outputDir);
    s.stop(`${c.success("✔")} Dependencies installed.`);
  } catch {
    s.stop(`${c.warn("⚠")} Install failed.`);
    p.log.warn(
      `Run ${c.highlight(`${packageManager} install`)} inside ${c.highlight(projectName)} to install dependencies.`
    );
  }

  if (initGit) {
    const gs = p.spinner();
    gs.start(`${c.dim("▸")} Initializing git repository...`);
    try {
      await initGitRepo(outputDir, true);
      gs.stop(`${c.success("✔")} Git repository initialized with initial commit.`);
    } catch {
      gs.stop(`${c.warn("⚠")} Git init failed.`);
      p.log.warn(
        `Run ${c.highlight("git init")} inside ${c.highlight(projectName)} to initialize git manually.`
      );
    }
  }

  if (dbPostInstallMessage) {
    p.note(dbPostInstallMessage, pc.bold("▸ Database setup notes"));
  }
}
