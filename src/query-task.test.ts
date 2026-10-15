import { describe, expect, test } from "bun:test";
import type { OwnerMessageRow } from "./query-signal-record";
import { saidRows, taskAt, taskStartsOf } from "./query-task";

const START = "2026-10-14T09:00:00.000Z";

const owner = (id: string, turnId: string | null, at: string, text: string, agentBefore: string | null) =>
  ({ id, turnId, sessionId: "s", at, text, agentBefore, midTurn: false }) satisfies OwnerMessageRow;

const COMMAND = owner("m1", "p1", START, "<command-name>/review</command-name>", null);

const LATER = owner("m3", null, "2026-10-14T09:30:00.000Z", "now add the printer", "Done.");

describe("the tasks of a top-level session", () => {
  test("opens at a slash command and takes each opening message's turn id, else its own id", () => {
    const starts = taskStartsOf("s", START, COMMAND, saidRows([COMMAND, LATER]));
    expect(starts.map(({ id, at }) => ({ id: String(id), at }))).toEqual([
      { id: "p1", at: START },
      { id: "m3", at: LATER.at },
    ]);
  });

  test("opens one task at a first user message that is itself a task prompt", () => {
    const prompt = owner("m1", "p1", "2026-10-14T09:00:05.000Z", "add the parser", "Ready.");
    const starts = taskStartsOf("s", START, prompt, saidRows([prompt]));
    expect(starts.map(({ id, at }) => ({ id: String(id), at }))).toEqual([{ id: "p1", at: prompt.at }]);
  });

  test("names a session with no user message by its id", () => {
    expect(taskStartsOf("s", START, null, []).map(({ id }) => String(id))).toEqual(["s"]);
  });

  test("places a time in the task whose start it follows", () => {
    const starts = taskStartsOf("s", START, COMMAND, saidRows([COMMAND, LATER]));
    expect(String(taskAt(starts, Date.parse("2026-10-14T09:29:59.000Z")).id)).toBe("p1");
    expect(String(taskAt(starts, Date.parse(LATER.at)).id)).toBe("m3");
  });
});
