import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { printBanner } from "../utils/logger.js";
import { runToolsMenu } from "../prompts/tools-prompt.js";
import type { CommandRunOptions } from "../types/index.js";

export async function runTools(options: CommandRunOptions = {}): Promise<void> {
  if (!options.fromMenu) {
    printBanner("run a veneko tool");
    p.intro(pc.bold(pc.cyan(" veneko tools ")));
  }

  await runToolsMenu();

  if (!options.fromMenu) {
    p.outro(pc.dim("Done."));
  }
}

export function registerToolsCommand(program: Command): void {
  program
    .command("tools")
    .description("Run a veneko tool")
    .action(async () => {
      await runTools();
    });
}
