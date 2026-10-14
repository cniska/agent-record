import { describe, expect, test } from "bun:test";
import { AGENT_TAIL_CHARS, classify } from "./query-interrupt";

const ASKED = "I pushed it. Should I start the next slice?";
const TOLD = "I pushed it and started the next slice.";

describe("telling an owner message that interrupts an agent from one that sets it a task", () => {
  test("reads the interrupted marker as a stop, whatever the agent said", () => {
    expect(classify("[Request interrupted by user]", ASKED)).toEqual({ kind: "interrupt", cause: "stop" });
    expect(classify("[Request interrupted by user for tool use]", null)).toEqual({
      kind: "interrupt",
      cause: "stop",
    });
  });

  test("reads a message before the agent said anything as a task", () => {
    expect(classify("no, add the parser", null)).toEqual({ kind: "task" });
  });

  test("reads a reply to a question as an answer", () => {
    expect(classify("the second one", ASKED)).toEqual({ kind: "interrupt", cause: "answer" });
  });

  test("looks for the question only near the end of what the agent said", () => {
    const early = `Is this right? ${"x".repeat(AGENT_TAIL_CHARS)}`;
    expect(classify("the second one", early)).toEqual({ kind: "task" });
    expect(classify("the second one", early.slice(-AGENT_TAIL_CHARS))).toEqual({ kind: "task" });
  });

  test("reads a push-back opening as a correction", () => {
    for (const text of ["no, the other file", "Don't touch main", "why reset?", "wait", "actually use zod"]) {
      expect(classify(text, TOLD)).toEqual({ kind: "interrupt", cause: "correct" });
    }
  });

  test("reads a short go-ahead as unblocking, and a long one as a task", () => {
    for (const text of ["yes", "go ahead", "OK, push it", "lgtm"]) {
      expect(classify(text, TOLD)).toEqual({ kind: "interrupt", cause: "unblock" });
    }
    expect(classify(`yes, and then ${"also ".repeat(20)}`, TOLD)).toEqual({ kind: "task" });
  });

  test("does not read a word that only starts like a push-back or a go-ahead", () => {
    expect(classify("notice the docs moved", TOLD)).toEqual({ kind: "task" });
    expect(classify("yesterday's run failed, look at it", TOLD)).toEqual({ kind: "task" });
  });

  test("reads anything else after the agent spoke as a new task", () => {
    expect(classify("now add the parser", TOLD)).toEqual({ kind: "task" });
  });

  test("leaves out a slash command, a shell escape and their output", () => {
    for (const text of [
      "<command-name>/clear</command-name>",
      "<local-command-stdout>done</local-command-stdout>",
      "<bash-input>ls</bash-input>",
    ]) {
      expect(classify(text, ASKED)).toEqual({ kind: "command" });
    }
  });
});
