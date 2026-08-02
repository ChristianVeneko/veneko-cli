import { readdir, readFile } from "fs/promises";
import { join } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getTemplatesDir } from "../utils/paths.js";
import { toKebabCase } from "../utils/name-utils.js";
import { c } from "../utils/logger.js";
import { isInstalled } from "../utils/package-manager.js";
import type { CreateConfig, TemplateManifest, DatabaseOption, PackageManager } from "../types/index.js";

interface TemplateOption {
  value: string;
  label: string;
  hint: string;
}

interface PackageManagerOption {
  value: PackageManager;
  label: string;
  hint?: string;
}

/**
 * Offers only the managers this machine can actually run. npm is always listed
 * because it ships with Node — without it a box with neither Bun nor pnpm would
 * be left with an empty prompt.
 */
async function packageManagerOptions(): Promise<PackageManagerOption[]> {
  const candidates: PackageManagerOption[] = [
    { value: "bun", label: "Bun", hint: "fastest" },
    { value: "pnpm", label: "pnpm", hint: "disk-efficient" },
  ];

  const available: PackageManagerOption[] = [];
  for (const candidate of candidates) {
    if (await isInstalled(candidate.value)) available.push(candidate);
  }

  available.push({ value: "npm", label: "npm", hint: "ships with Node" });
  return available;
}

async function discoverTemplates(): Promise<TemplateOption[]> {
  const templatesDir = getTemplatesDir();
  let entries: string[] = [];

  try {
    entries = await readdir(templatesDir);
  } catch {
    return [];
  }

  const options: TemplateOption[] = [];

  for (const entry of entries) {
    const manifestPath = join(templatesDir, entry, "template.json");
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as TemplateManifest;
      options.push({
        value: manifest.name,
        label: manifest.displayName,
        hint: manifest.description,
      });
    } catch {
      // skip invalid template directories
    }
  }

  return options;
}

function validateProjectName(value: string): string | undefined {
  if (!value || value.trim().length === 0) {
    return "Project name is required.";
  }
  if (/\s/.test(value)) {
    return "Project name cannot contain spaces. Use kebab-case (e.g. my-app).";
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    return "Project name must be lowercase letters, numbers, and hyphens only.";
  }
  return undefined;
}

function cancelIfNeeded(value: unknown): asserts value is NonNullable<typeof value> {
  if (p.isCancel(value)) {
    p.cancel("Operation cancelled.");
    process.exit(1);
  }
}

/**
 * Asks for the project name, unless `veneko create <name>` already supplied
 * one. An invalid name from the command line falls through to the prompt with
 * the reason shown, rather than exiting — the user is right there to fix it.
 */
async function askProjectName(suggested?: string): Promise<string> {
  if (suggested !== undefined) {
    const problem = validateProjectName(suggested);
    if (!problem) {
      p.log.step(`Project name ${c.highlight(suggested)}`);
      return suggested;
    }
    p.log.warn(`${problem} Pick another one.`);
  }

  const projectName = await p.text({
    message: "Project name",
    placeholder: "my-app",
    validate: validateProjectName,
  });
  cancelIfNeeded(projectName);

  return projectName as string;
}

export async function runCreatePrompt(suggestedName?: string): Promise<CreateConfig> {
  const templates = await discoverTemplates();

  if (templates.length === 0) {
    p.cancel(
      `${c.error("✖")} No templates found.\n` +
      pc.dim("  Make sure the templates directory exists and your veneko installation is intact.")
    );
    process.exit(1);
  }

  const projectName = await askProjectName(suggestedName);
  const safeName = toKebabCase(projectName);

  const template = await p.select({
    message: "Select a template",
    options: templates,
  });
  cancelIfNeeded(template);

  const selectedTemplate = templates.find((t) => t.value === template);

  let database: DatabaseOption = "none";

  const manifestPath = join(
    getTemplatesDir(),
    template as string,
    "template.json"
  );
  let manifest: TemplateManifest | null = null;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as TemplateManifest;
  } catch {
    // continue without manifest
  }

  const supportsDb =
    manifest?.supportedFeatures.some((f) => f.startsWith("db-")) ?? false;

  if (supportsDb) {
    const dbChoice = await p.select({
      message: "Database",
      options: [
        { value: "none", label: "None" },
        { value: "postgres", label: "PostgreSQL" },
        { value: "mysql", label: "MySQL" },
        { value: "sqlite", label: "SQLite" },
      ],
    });
    cancelIfNeeded(dbChoice);
    database = dbChoice as DatabaseOption;
  }

  const packageManager = await p.select({
    message: "Package manager",
    options: await packageManagerOptions(),
  });
  cancelIfNeeded(packageManager);

  const initGit = await p.confirm({
    message: "Initialize git repository?",
    initialValue: true,
  });
  cancelIfNeeded(initGit);

  const generateClaudeMd = await p.confirm({
    message: "Generate CLAUDE.md?",
    initialValue: true,
  });
  cancelIfNeeded(generateClaudeMd);

  const outputDir = join(process.cwd(), safeName);

  const summary = [
    `${pc.bold("Project")}     ${c.highlight(safeName)}`,
    `${pc.bold("Template")}    ${c.info(selectedTemplate?.label ?? (template as string))}`,
    `${pc.bold("Database")}    ${database === "none" ? pc.dim("none") : c.info(database)}`,
    `${pc.bold("Manager")}     ${c.info(packageManager as string)}`,
    `${pc.bold("Git")}         ${(initGit as boolean) ? c.success("yes") : pc.dim("no")}`,
    `${pc.bold("CLAUDE.md")}   ${(generateClaudeMd as boolean) ? c.success("yes") : pc.dim("no")}`,
    `${pc.bold("Output")}      ${pc.dim(outputDir)}`,
  ].join("\n");

  p.note(summary, pc.bold("▸ Project summary"));

  const proceed = await p.confirm({
    message: "Create project?",
    initialValue: true,
  });
  cancelIfNeeded(proceed);

  if (!proceed) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  return {
    projectName: safeName,
    template: template as string,
    database,
    packageManager: packageManager as PackageManager,
    initGit: initGit as boolean,
    generateClaudeMd: generateClaudeMd as boolean,
    outputDir,
  };
}
