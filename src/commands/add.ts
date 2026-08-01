import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";
import { detectProject } from "../utils/detect-project.js";
import { runAddPrompt } from "../prompts/add-prompt.js";
import { applyFeature, featureExists, loadTemplateManifest } from "../generators/feature-generator.js";
import { install } from "../utils/package-manager.js";
import { cancelAndExit, printBanner, c } from "../utils/logger.js";
import { toKebabCase, toPascalCase, toCamelCase } from "../utils/name-utils.js";
import type { CommandRunOptions, TemplateContext } from "../types/index.js";
import { readFile } from "fs/promises";
import { join } from "path";

interface AddRunOptions extends CommandRunOptions {
  dir?: string;
}

export async function runAdd(
  feature: string | undefined,
  options: AddRunOptions = {}
): Promise<void> {
  if (!options.fromMenu) {
    printBanner("add features to an existing project");
    p.intro(pc.bold(pc.cyan(" veneko add ")));
  }

  const projectDir = options.dir ?? process.cwd();

  const detected = await detectProject(projectDir);
  if (!detected) {
    p.log.error(
      `${c.error("✖ No veneko project detected in this directory.")}\n` +
      pc.dim("  Run this command from inside a project created with veneko.")
    );
    cancelAndExit();
    return;
  }

  if (detected.framework === "unknown") {
    p.log.error(
      `${c.error("✖ Could not detect a supported framework.")}\n` +
      pc.dim("  Supported frameworks: nestjs, nextjs, nuxt")
    );
    cancelAndExit();
    return;
  }

  let templateManifest: { supportedFeatures: import("../types/index.js").FeatureName[]; displayName: string };
  try {
    templateManifest = await loadTemplateManifest(detected.framework);
  } catch {
    p.log.error(
      `${c.error(`✖ No veneko template found for framework: ${detected.framework}`)}\n` +
      pc.dim("  Make sure your veneko installation is not corrupted.")
    );
    cancelAndExit();
    return;
  }

  p.log.info(`${c.dim("▸")} Detected ${c.highlight(detected.framework)} project`);

  const config = await runAddPrompt(detected, templateManifest.supportedFeatures, feature);

  const exists = await featureExists(config.detectedTemplate, config.feature);
  if (!exists) {
    p.log.error(
      `${c.error(`✖ Feature "${config.feature}" is not available for ${config.detectedTemplate}`)}\n` +
      pc.dim(`  Available features: ${templateManifest.supportedFeatures.join(", ")}`)
    );
    cancelAndExit();
    return;
  }

  let projectName = "project";
  try {
    const pkgRaw = await readFile(join(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as { name?: string };
    if (pkg.name) projectName = pkg.name;
  } catch {
    // use default
  }

  const context: TemplateContext = {
    projectName,
    projectNameKebab: toKebabCase(projectName),
    projectNamePascal: toPascalCase(projectName),
    projectNameCamel: toCamelCase(projectName),
    database: "none",
    packageManager: config.packageManager,
    year: new Date().getFullYear(),
  };

  const s = p.spinner();
  s.start(`${c.dim("▸")} Applying ${c.highlight(config.feature)} feature files...`);
  let postInstallMessage: string | undefined;
  try {
    postInstallMessage = await applyFeature(
      config.detectedTemplate,
      config.feature,
      projectDir,
      context
    );
    s.stop(`${c.success("✔")} Feature files applied.`);
  } catch (err) {
    s.stop(`${c.error("✖")} Failed to apply feature files.`);
    p.log.error(
      `${String(err)}\n` +
      pc.dim("  Try running with elevated permissions or check file write access.")
    );
    cancelAndExit();
    return;
  }

  const is = p.spinner();
  is.start(`${c.dim("▸")} Installing dependencies with ${c.highlight(config.packageManager)}...`);
  try {
    await install(config.packageManager, projectDir);
    is.stop(`${c.success("✔")} Dependencies installed.`);
  } catch {
    is.stop(`${c.warn("⚠")} Install step failed.`);
    p.log.warn(
      `Run ${c.highlight(`${config.packageManager} install`)} manually to install new dependencies.`
    );
  }

  if (postInstallMessage) {
    p.note(postInstallMessage, pc.bold("▸ Post-install notes"));
  }

  p.outro(
    `${c.success("✔")} Feature ${c.highlight(config.feature)} added to ${c.highlight(projectName)}`
  );
}

export function registerAddCommand(program: Command): void {
  program
    .command("add [feature]")
    .description("Add a feature to an existing project")
    .option("-d, --dir <directory>", "Project directory", process.cwd())
    .action(async (feature: string | undefined, options: { dir: string }) => {
      await runAdd(feature, { dir: options.dir });
    });
}
