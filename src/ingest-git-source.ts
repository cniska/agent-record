import { existsSync } from "node:fs";
import { ran, ranRaw } from "./git";
import { checkoutRoot } from "./git-checkout";
import { refuseGit } from "./git-contract";

export type Commit = {
  sha: string;
  ts: string;
  author: string | null;
  subject: string;
  kind: string | null;
  files: string[];
};

const NUL = "\0";

const HEADER_FIELDS = 4;

export function commitKind(subject: string): string | null {
  const match = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject);
  return match?.[1] ?? null;
}

export function repoRoot(dir: string): string | null {
  if (!existsSync(dir) || checkoutRoot(dir) === null) return null;
  return ran(dir, ["rev-parse", "--show-toplevel"]);
}

export function readCommits(checkout: string, head: string, since: string | null): Commit[] {
  const args = [
    "log",
    head,
    "--pretty=format:%x00%H%x00%aI%x00%an%x00%s",
    "--name-only",
    "--no-merges",
    "--no-renames",
  ];
  if (since) args.push(`--since=${since}`);
  return commitsOf(ranRaw(checkout, args), `git ${args.join(" ")}`);
}

export function commitsOf(output: string, command: string): Commit[] {
  const records: { readonly header: string; readonly files: string[] }[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith(NUL)) {
      records.push({ header: line.slice(NUL.length), files: [] });
      continue;
    }
    if (line.trim() === "") continue;
    const record = records.at(-1);
    if (!record)
      throw refuseGit("git_output_malformed", { command, problem: "a file name before any commit record" });
    record.files.push(line.trim());
  }
  return records.map(({ header, files }) => commitOf(header, files, command));
}

function commitOf(header: string, files: readonly string[], command: string): Commit {
  const fields = header.split(NUL);
  const [sha, ts, author, subject] = fields;
  if (
    fields.length !== HEADER_FIELDS ||
    !sha ||
    !ts ||
    subject === undefined ||
    Number.isNaN(Date.parse(ts))
  ) {
    throw refuseGit("git_output_malformed", {
      command,
      problem: "a commit record without a sha, a date, an author field and a subject",
    });
  }
  return {
    sha,
    ts: new Date(ts).toISOString(),
    author: author || null,
    subject,
    kind: commitKind(subject),
    files: [...files],
  };
}
