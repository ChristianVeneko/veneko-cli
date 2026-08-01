import {
  intro,
  outro,
  log,
  spinner,
  cancel,
  isCancel,
  text,
  select,
  multiselect,
  confirm,
  note,
} from "@clack/prompts";
import pc from "picocolors";

export {
  intro,
  outro,
  log,
  spinner,
  cancel,
  isCancel,
  text,
  select,
  multiselect,
  confirm,
  note,
};

export const c = {
  success: (s: string) => pc.green(s),
  info: (s: string) => pc.cyan(s),
  warn: (s: string) => pc.yellow(s),
  error: (s: string) => pc.red(s),
  dim: (s: string) => pc.dim(s),
  bold: (s: string) => pc.bold(s),
  highlight: (s: string) => pc.cyan(pc.bold(s)),
};

const BANNER_LINES = [
  pc.cyan(pc.bold("  ██╗   ██╗███████╗███╗   ██╗███████╗██╗  ██╗ ██████╗")),
  pc.cyan(pc.bold("  ██║   ██║██╔════╝████╗  ██║██╔════╝██║ ██╔╝██╔═══██╗")),
  pc.cyan(pc.bold("  ██║   ██║█████╗  ██╔██╗ ██║█████╗  █████╔╝ ██║   ██║")),
  pc.dim( "  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██╔══╝  ██╔═██╗ ██║   ██║"),
  pc.dim( "   ╚████╔╝ ███████╗██║ ╚████║███████╗██║  ██╗╚██████╔╝"),
  pc.dim( "    ╚═══╝  ╚══════╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ "),
];

export function printBanner(tagline?: string): void {
  process.stdout.write("\n");
  for (const line of BANNER_LINES) {
    process.stdout.write(line + "\n");
  }
  if (tagline) {
    process.stdout.write(pc.dim(`  ${tagline}`) + "\n");
  }
  process.stdout.write("\n");
}

export function cancelAndExit(message?: string): never {
  cancel(message ?? pc.red("Operation cancelled."));
  process.exit(1);
}
