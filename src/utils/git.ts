import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, shell: true });
}

export async function initGitRepo(
  projectDir: string,
  withBranches: boolean
): Promise<void> {
  await git(["init"], projectDir);
  await git(["add", "."], projectDir);
  await git(
    ["commit", "-m", "chore: initial project scaffold via veneko-cli"],
    projectDir
  );

  if (withBranches) {
    await git(["checkout", "-b", "development"], projectDir);
    await git(["branch", "staging"], projectDir);
  }
}
