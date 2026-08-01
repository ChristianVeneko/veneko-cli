import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { printBanner } from "../utils/logger.js";
import { runConfigMenu } from "../prompts/config-prompt.js";
import type { CommandRunOptions } from "../types/index.js";

export async function runConfig(options: CommandRunOptions = {}): Promise<void> {
  if (!options.fromMenu) {
    printBanner("configure credentials and defaults");
    p.intro(pc.bold(pc.cyan(" veneko config ")));
  }

  await runConfigMenu();

  if (!options.fromMenu) {
    p.outro(pc.dim("Configuration saved."));
  }
}

export function registerConfigCommand(program: Command): void {
  program
    .command("config")
    .description("Configure AI provider credentials and default model")
    .action(async () => {
      await runConfig();
    });
}
