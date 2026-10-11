import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { refuseGit } from "./git-contract";

export type GitRun = { readonly status: number; readonly out: string; readonly err: string };

export function git(repo: string, args: readonly string[]): GitRun {
  const run = spawnSync("git", ["-C", repo, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (run.error) throw run.error;
  const status = run.status ?? 128 + (run.signal === null ? 0 : constants.signals[run.signal]);
  return { status, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

function refused(repo: string, args: readonly string[], run: GitRun) {
  return refuseGit("git_failed", {
    repo,
    command: `git ${args.join(" ")}`,
    status: run.status,
    detail: run.err,
  });
}

export function ranRaw(repo: string, args: readonly string[]): string {
  const run = git(repo, args);
  if (run.status !== 0) throw refused(repo, args, run);
  return run.out;
}

export function ran(repo: string, args: readonly string[]): string {
  return ranRaw(repo, args).trim();
}

function answered(repo: string, args: readonly string[]): string | null {
  const run = git(repo, args);
  if (run.status === 1) return null;
  if (run.status !== 0) throw refused(repo, args, run);
  return run.out.trim();
}

export function nulFields(output: string, command: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) {
    throw refuseGit("git_output_malformed", { command, problem: "a record that does not end in NUL" });
  }
  return output.slice(0, -1).split("\0");
}

export function configValue(repo: string, key: string): string | null {
  return answered(repo, ["config", "--get", key]);
}

export function hasCommit(repo: string, at: string): boolean {
  return answered(repo, ["rev-parse", "--verify", "-q", `${at}^{commit}`]) !== null;
}
