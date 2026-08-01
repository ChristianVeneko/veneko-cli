import * as p from "@clack/prompts";
import pc from "picocolors";
import { printBanner } from "../utils/logger.js";
import { runCreate } from "./create.js";
import { runAdd } from "./add.js";
import { runTools } from "./tools.js";
import { runConfig } from "./config.js";

type MenuAction = "create" | "add" | "tools" | "config" | "exit";

const MENU_OPTIONS: { value: MenuAction; label: string; hint: string }[] = [
  {
    value: "create",
    label: "Create a new project",
    hint: "scaffold from a template",
  },
  {
    value: "add",
    label: "Add a feature",
    hint: "extend an existing project",
  },
  {
    value: "tools",
    label: "Tools",
    hint: "AI-powered utilities",
  },
  {
    value: "config",
    label: "Configuration",
    hint: "credentials and defaults",
  },
  {
    value: "exit",
    label: "Exit",
    hint: "close veneko",
  },
];

export async function runInteractiveMenu(): Promise<void> {
  printBanner("personal CLI tool for project scaffolding");

  p.intro(pc.bold(pc.cyan(" veneko ")));

  // Tools and configuration return to this menu; create and add end the session.
  for (;;) {
    const action = await p.select<MenuAction>({
      message: "What do you want to do?",
      options: MENU_OPTIONS,
    });

    if (p.isCancel(action) || action === "exit") {
      p.outro(pc.dim("See you next time."));
      return;
    }

    switch (action) {
      case "create":
        await runCreate({ fromMenu: true });
        return;
      case "add":
        await runAdd(undefined, { fromMenu: true });
        return;
      case "tools":
        await runTools({ fromMenu: true });
        break;
      case "config":
        await runConfig({ fromMenu: true });
        break;
    }
  }
}
