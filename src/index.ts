import { Command } from "commander";
import { registerCreateCommand } from "./commands/create.js";
import { registerAddCommand } from "./commands/add.js";

const program = new Command();

program
  .name("veneko")
  .version("0.1.0")
  .description("Personal CLI tool for project scaffolding");

registerCreateCommand(program);
registerAddCommand(program);

program.parse();
