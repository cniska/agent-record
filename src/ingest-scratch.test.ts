import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isScratchRepo } from "./ingest-scratch";

const OWN_TEMP = { tmpDir: tmpdir() };

describe("a scratch tree is not the work", () => {
  test("an agent's own scratchpad is one", () => {
    expect(
      isScratchRepo("/private/tmp/claude-501/a-project/a-session/scratchpad/runs/run-103", OWN_TEMP),
    ).toBe(true);
  });

  test("the symlink and its target both count, because a cwd records either", () => {
    expect(isScratchRepo("/tmp/experiment", OWN_TEMP)).toBe(true);
    expect(isScratchRepo("/private/tmp/experiment", OWN_TEMP)).toBe(true);
  });

  test("whatever this machine calls its temp directory counts", () => {
    expect(isScratchRepo(join(tmpdir(), "agent-record-git-abc123"), OWN_TEMP)).toBe(true);
  });

  test("the resolved spelling of the temp directory counts too", () => {
    expect(isScratchRepo(join(realpathSync(tmpdir()), "agent-record-git-abc123"), OWN_TEMP)).toBe(true);
  });

  test("a per-user darwin temp tree counts", () => {
    expect(isScratchRepo("/private/var/folders/v5/9g9nzrss/T/agent-record-git-abc123", OWN_TEMP)).toBe(true);
    expect(isScratchRepo("/var/folders/v5/9g9nzrss/T/agent-record-git-abc123", OWN_TEMP)).toBe(true);
  });

  test("the temp root itself counts", () => {
    expect(isScratchRepo(resolve(tmpdir()), OWN_TEMP)).toBe(true);
  });

  test("a checkout the person keeps does not", () => {
    expect(isScratchRepo("/Users/someone/code/demo", OWN_TEMP)).toBe(false);
    expect(isScratchRepo("/Users/someone/code/one/.claude/worktrees/task-a", OWN_TEMP)).toBe(false);
  });

  test("a path that merely begins with the same letters does not", () => {
    expect(isScratchRepo("/tmpfiles/code/thing", OWN_TEMP)).toBe(false);
    expect(isScratchRepo("/private/tmpfoo/thing", OWN_TEMP)).toBe(false);
  });

  test("a temp directory that is gone judges by name alone", () => {
    expect(
      isScratchRepo("/Users/someone/code/demo", { tmpDir: "/agent-record-temp-directory-that-is-gone" }),
    ).toBe(false);
  });

  test("a relative path is judged where it actually resolves", () => {
    const cwd = process.cwd();
    try {
      process.chdir("/");
      expect(isScratchRepo("code/demo", OWN_TEMP)).toBe(false);
      process.chdir(realpathSync(tmpdir()));
      expect(isScratchRepo("code/demo", OWN_TEMP)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
