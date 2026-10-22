import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { readRows } from "./db";
import { projectOf, withoutWorktree, worktreeAt, worktreeCheckout, worktreeOf } from "./worktree";

describe("naming the worktree a path sits in", () => {
  test("names it, and nothing for a primary checkout", () => {
    expect(worktreeOf("/h/code/one/.claude/worktrees/side/lib/x.dart")).toBe("side");
    expect(worktreeOf("/h/code/one/.claude/worktrees/side")).toBe("side");
    expect(worktreeOf("/h/code/one/lib/x.dart")).toBeNull();
    expect(worktreeOf("/h/code/one/.claude/settings.json")).toBeNull();
    expect(worktreeOf(null)).toBeNull();
  });

  test("splits a worktree path into its checkout and the worktree's name", () => {
    const cwd = "/h/code/one/.claude/worktrees/side";
    expect([projectOf(cwd), worktreeOf(cwd)]).toEqual(["/h/code/one", "side"]);
    expect([projectOf("/h/code/one"), worktreeOf("/h/code/one")]).toEqual(["/h/code/one", null]);
    expect([projectOf(null), worktreeOf(null)]).toEqual([null, null]);
  });

  test("finds the worktree a path lies in and names its checkout, and nothing outside one", () => {
    const side = worktreeAt("/h/code/one/.claude/worktrees/side/lib/x.dart");
    expect(side).toEqual({ project: "/h/code/one", name: "side" });
    expect(worktreeCheckout({ project: "/h/code/one", name: "side" })).toBe(
      "/h/code/one/.claude/worktrees/side",
    );
    expect(worktreeAt("/h/code/one/.claude/worktrees/side")).toEqual({
      project: "/h/code/one",
      name: "side",
    });
    expect(worktreeAt("/h/code/one/.claude/worktrees/")).toBeNull();
    expect(worktreeAt("/h/code/one/lib/x.dart")).toBeNull();
    expect(worktreeAt(null)).toBeNull();
  });

  test("a worktree checkout collapses onto the file it is a copy of", () => {
    const db = new Database(":memory:");
    try {
      const expr = withoutWorktree("p");
      const one = (p: string) =>
        readRows<[string]>(db, `SELECT ${expr} AS out FROM (SELECT ? AS p)`).get(
          z.strictObject({ out: z.string() }),
          p,
        )?.out;

      expect(one("/h/code/one/.claude/worktrees/side/docs/x.md")).toBe("/h/code/one/docs/x.md");
      expect(one("/h/code/one/docs/x.md")).toBe("/h/code/one/docs/x.md");
      expect(one("/h/code/one/.claude/settings.json")).toBe("/h/code/one/.claude/settings.json");
      expect(one("/h/code/one/.claude/worktrees/side")).toBe("/h/code/one");
    } finally {
      db.close();
    }
  });
});
