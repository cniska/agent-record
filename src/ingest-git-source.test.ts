import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitKind, commitsOf, readCommits } from "./ingest-git-source";

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

function repoWith(subjects: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-record-git-"));
  git(["init", "-q", "-b", "main"], dir);
  subjects.forEach((subject, i) => {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(["add", "."], dir);
    git(["commit", "-q", "-m", subject], dir);
  });
  return dir;
}

describe("commit kind", () => {
  test("reads the conventional-commits type, scope and breaking marker alike", () => {
    expect(commitKind("fix: stop the double count")).toBe("fix");
    expect(commitKind("feat(query): add a window")).toBe("feat");
    expect(commitKind("fix(api)!: change the shape")).toBe("fix");
  });

  test("is null when there is no type to read, rather than guessing one", () => {
    expect(commitKind("stop the double count")).toBeNull();
    expect(commitKind("WIP")).toBeNull();
    expect(commitKind("something: else")).toBe("something");
  });
});

describe("reading a log record", () => {
  test("keeps a subject that holds control characters whole", () => {
    const repo = repoWith(["feat: one\x1etail\x1fend"]);
    try {
      expect(readCommits(repo, "HEAD", null).map((commit) => commit.subject)).toEqual([
        "feat: one\x1etail\x1fend",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reads each record's header and the files after it", () => {
    expect(
      commitsOf(
        "\0abc\x002026-10-12T07:00:00+03:00\0Ann\0fix: a\na.ts\nb.ts\n\n\0def\x002026-10-11T07:00:00+03:00\0\0b\n",
        "git log",
      ),
    ).toEqual<object[]>([
      {
        sha: "abc",
        ts: "2026-10-12T04:00:00.000Z",
        author: "Ann",
        subject: "fix: a",
        kind: "fix",
        files: ["a.ts", "b.ts"],
      },
      { sha: "def", ts: "2026-10-11T04:00:00.000Z", author: null, subject: "b", kind: null, files: [] },
    ]);
    expect(commitsOf("", "git log")).toEqual([]);
  });

  test("refuses output git does not print rather than skipping it", () => {
    for (const output of [
      "\0abc\x002026-10-12T07:00:00+03:00\0Ann\n",
      "\0\x002026-10-12T07:00:00+03:00\0Ann\0s\n",
      "\0abc\0not a date\0Ann\0s\n",
      "orphan.ts\n\0abc\x002026-10-12T07:00:00+03:00\0Ann\0s\n",
    ]) {
      expect(() => commitsOf(output, "git log")).toThrow(
        expect.objectContaining({
          kind: "refusal",
          code: "git_output_malformed",
          meta: expect.objectContaining({ command: "git log" }),
        }),
      );
    }
  });
});

describe("reading a repo", () => {
  test("reads each commit with the files it touched", () => {
    const dir = repoWith(["feat: one", "fix: two"]);
    try {
      const commits = readCommits(dir, "HEAD", null);
      expect(commits.length).toBe(2);
      const fix = commits.find((c) => c.subject === "fix: two");
      expect(fix?.kind).toBe("fix");
      expect(fix?.files).toEqual(["f1.txt"]);
      expect(fix?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
