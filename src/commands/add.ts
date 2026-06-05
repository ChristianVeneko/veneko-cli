import * as p from "@clack/prompts";
import type { Command } from "commander";
import { detectProject } from "../utils/detect-project.js";
import { runAddPrompt } from "../prompts/add-prompt.js";
import { applyFeature, featureExists, loadTemplateManifest } from "../generators/feature-generator.js";
import { install } from "../utils/package-manager.js";
import { cancelAndExit } from "../utils/logger.js";
import { toKebabCase, toPascalCase, toCamelCase } from "../utils/name-utils.js";
import type { TemplateContext } from "../types/index.js";
import { readFile } from "fs/promises";
import { join } from "path";

export function registerAddCommand(program: Command): void {
  program
    .command("add [feature]")
    .description("Add a feature to an existing project")
    .option("-d, --dir <directory>", "Project directory", process.cwd())
    .action(async (feature: string | undefined, options: { dir: string }) => {
      p.intro("veneko — add feature");

      const projectDir = options.dir;

      const detected = await detectProject(projectDir);
      if (!detected) {
        p.log.error("No project detected in this directory.");
        cancelAndExit();
        return;
      }

      if (detected.framework === "unknown") {
        p.log.error("Could not detect a supported framework.");
        cancelAndExit();
        return;
      }

      let templateManifest: { supportedFeatures: import("../types/index.js").FeatureName[]; displayName: string };
      try {
        templateManifest = await loadTemplateManifest(detected.framework);
      } catch {
        p.log.error(`No veneko template found for framework: ${detected.framework}`);
        cancelAndExit();
        return;
      }

      const config = await runAddPrompt(detected, templateManifest.supportedFeatures, feature);

      const exists = await featureExists(config.detectedTemplate, config.feature);
      if (!exists) {
        p.log.error(`Feature overlay "${config.feature}" is not available for ${config.detectedTemplate}.`);
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
      s.start(`Applying feature ${config.feature}...`);
      let postInstallMessage: string | undefined;
      try {
        postInstallMessage = await applyFeature(
          config.detectedTemplate,
          config.feature,
          projectDir,
          context
        );
        s.stop("Feature files applied.");
      } catch (err) {
        s.stop("Failed to apply feature.");
        p.log.error(String(err));
        cancelAndExit();
        return;
      }

      const is = p.spinner();
      is.start(`Installing new dependencies with ${config.packageManager}...`);
      try {
        await install(config.packageManager, projectDir);
        is.stop("Dependencies installed.");
      } catch {
        is.stop("Install failed — run the install command manually.");
      }

      if (postInstallMessage) {
        p.log.info(postInstallMessage);
      }

      p.outro("Feature added successfully.");
    });
}
