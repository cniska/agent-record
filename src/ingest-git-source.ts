import { ran } from "./git";
import { refuseGit } from "./git-contract";
import { Timestamp } from "./timestamp";

export type Commit = {
  sha: string;
  ts: Timestamp;
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

export function readCommits(checkout: string, head: string, since: Timestamp | null): Commit[] {
  const args = [
    "log",
    head,
    "--pretty=format:%x00%H%x00%aI%x00%an%x00%s",
    "--name-only",
    "--no-merges",
    "--no-renames",
  ];
  if (since) args.push(`--since=${since}`);
  return commitsOf(ran(checkout, args), `git ${args.join(" ")}`);
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
  const [sha, date, author, subject] = fields;
  const ts = Timestamp.safeParse(date);
  if (fields.length !== HEADER_FIELDS || !sha || !ts.success || subject === undefined) {
    throw refuseGit("git_output_malformed", {
      command,
      problem: "a commit record without a sha, a date, an author field and a subject",
    });
  }
  return {
    sha,
    ts: ts.data,
    author: author || null,
    subject,
    kind: commitKind(subject),
    files: [...files],
  };
}
