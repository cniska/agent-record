import { describe, expect, test } from "bun:test";
import { parseArg, parseFlags } from "./cli-flags";
import { refusal } from "./db-read.test-support";

const usage = "agent-record review <id> [--reason <r>] [--decided <who>]";

const FLAGS = ["reason", "decided"] as const;

describe("a command's arguments", () => {
  test("reads each flag's value and the argument around them", () => {
    expect(parseArg(["k7", "--reason", "fine", "--decided", "owner"], FLAGS, usage)).toEqual({
      arg: "k7",
      flags: { reason: "fine", decided: "owner" },
    });
    expect(parseFlags(["--reason", "fine"], FLAGS, usage)).toEqual({ reason: "fine" });
  });

  test("finds the argument by position, so one equal to a flag's value survives", () => {
    expect(parseArg(["5", "--rows", "5"], ["rows"], usage)).toEqual({ arg: "5", flags: { rows: "5" } });
    expect(parseArg(["--rows", "5", "5"], ["rows"], usage).arg).toBe("5");
  });

  test("trims the argument, so a pasted id's stray whitespace still matches", () => {
    expect(parseArg([" k7\n", "--reason", " fine "], FLAGS, usage)).toEqual({
      arg: "k7",
      flags: { reason: " fine " },
    });
  });

  test("refuses a flag the command does not take, naming it and resolving with the usage", () => {
    expect(refusal(() => parseArg(["k7", "--by", "someone"], FLAGS, usage))).toMatchObject({
      code: "unknown_flag",
      message: "--by is not a flag this command takes",
      meta: { usage, flag: "--by" },
      resolve: usage,
      kind: "refusal",
    });
  });

  test("refuses a flag given twice", () => {
    expect(refusal(() => parseArg(["k7", "--reason", "a", "--reason", "b"], FLAGS, usage))).toMatchObject({
      code: "flag_repeated",
      message: "--reason is given twice",
      meta: { usage, flag: "--reason" },
      resolve: usage,
    });
  });

  test("refuses a flag with no value, or another flag where its value goes", () => {
    for (const args of [
      ["k7", "--reason"],
      ["k7", "--reason", "--decided", "owner"],
    ]) {
      expect(refusal(() => parseArg(args, FLAGS, usage))).toMatchObject({
        code: "flag_without_value",
        message: "--reason needs a value",
        meta: { usage, flag: "--reason" },
        resolve: usage,
      });
    }
  });

  test("refuses a missing argument, or more than the one it takes, naming what it got", () => {
    expect(refusal(() => parseArg([], FLAGS, usage))).toMatchObject({
      code: "argument_count",
      message: "takes 1 argument and got 0",
      meta: { usage, takes: 1, got: [] },
      resolve: usage,
    });
    expect(refusal(() => parseArg(["k7", "plan"], FLAGS, usage))).toMatchObject({
      code: "argument_count",
      message: "takes 1 argument and got 2: k7 plan",
      meta: { usage, takes: 1, got: ["k7", "plan"] },
    });
  });

  test("refuses an argument where a command takes none", () => {
    expect(refusal(() => parseFlags(["extra"], FLAGS, usage))).toMatchObject({
      code: "argument_count",
      message: "takes no arguments and got 1: extra",
      meta: { usage, takes: 0, got: ["extra"] },
      resolve: usage,
    });
  });

  test("refuses a blank argument, so a command never runs on nothing", () => {
    for (const args of [[""], ["   "]]) {
      expect(refusal(() => parseArg(args, FLAGS, usage))).toMatchObject({
        code: "blank_argument",
        message: "the argument is blank",
        meta: { usage },
        resolve: usage,
      });
    }
  });
});
