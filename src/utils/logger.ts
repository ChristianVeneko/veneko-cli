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
} from "@clack/prompts";

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
};

export function cancelAndExit(message?: string): never {
  cancel(message ?? "Operation cancelled.");
  process.exit(1);
}
