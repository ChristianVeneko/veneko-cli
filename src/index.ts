import { Command } from "commander";
import { registerCreateCommand } from "./commands/create.js";
import { registerAddCommand } from "./commands/add.js";
import { registerToolsCommand } from "./commands/tools.js";
import { registerConfigCommand } from "./commands/config.js";
import { runInteractiveMenu } from "./commands/menu.js";

const program = new Command();

program
  .name("veneko")
  .version("0.1.0")
  .description("Personal CLI tool for project scaffolding");

registerCreateCommand(program);
registerAddCommand(program);
registerToolsCommand(program);
registerConfigCommand(program);

const hasArgs = process.argv.slice(2).length > 0;
const isInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true;

if (hasArgs) {
  program.parse();
} else if (isInteractive) {
  await runInteractiveMenu();
} else {
  // No arguments and no terminal to draw a menu on (piped input, CI, etc.).
  program.outputHelp();
}
