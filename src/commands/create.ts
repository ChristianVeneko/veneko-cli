import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { runCreatePrompt } from "../prompts/create-prompt.js";
import { generateProject } from "../generators/project-generator.js";
import { printBanner, c } from "../utils/logger.js";
import { getRunCommand } from "../utils/package-manager.js";
import type { CommandRunOptions, CreateConfig } from "../types/index.js";

function buildOutroSummary(config: CreateConfig, templateLabel: string): string {
  const pm = config.packageManager;
  const startCmd = `${getRunCommand(pm)} start:dev`;

  return [
    `${pc.bold("Project")}    ${c.highlight(config.projectName)}`,
    `${pc.bold("Template")}   ${templateLabel}`,
    `${pc.bold("Database")}   ${config.database === "none" ? pc.dim("none") : c.info(config.database)}`,
    `${pc.bold("Manager")}    ${c.info(pm)}`,
    "",
    pc.bold("Next steps:"),
    `  ${pc.dim("▸")} ${c.highlight(`cd ${config.projectName}`)}`,
    `  ${pc.dim("▸")} ${c.highlight(startCmd)}`,
  ].join("\n");
}

export interface CreateRunOptions extends CommandRunOptions {
  /** Name passed as `veneko create <name>`, skipping that prompt. */
  projectName?: string;
}

export async function runCreate(options: CreateRunOptions = {}): Promise<void> {
  if (!options.fromMenu) {
    printBanner("scaffold a new project in seconds");
    p.intro(pc.bold(pc.cyan(" veneko create ")));
  }

  const config = await runCreatePrompt(options.projectName);
  await generateProject(config);

  const templateLabel = config.template;
  p.note(buildOutroSummary(config, templateLabel), pc.bold("▸ Ready to build"));

  p.outro(
    `${c.success("✔")} Project ${c.highlight(config.projectName)} created successfully!`
  );
}

export function registerCreateCommand(program: Command): void {
  program
    .command("create [project-name]")
    .description("Scaffold a new project from a template")
    .action(async (projectName?: string) => {
      await runCreate({ projectName });
    });
}
