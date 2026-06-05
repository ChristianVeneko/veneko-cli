import type { Command } from "commander";
import * as p from "@clack/prompts";
import { runCreatePrompt } from "../prompts/create-prompt.js";
import { generateProject } from "../generators/project-generator.js";

export function registerCreateCommand(program: Command): void {
  program
    .command("create [project-name]")
    .description("Scaffold a new project from a template")
    .action(async () => {
      p.intro("veneko create");
      const config = await runCreatePrompt();
      await generateProject(config);
      p.outro("Project created!");
    });
}
