import { sessionByPrefix } from "./query";
import type { Query } from "./query-contract";
import { readTasks, rootOf } from "./query-task";

const PROMPT_HEAD_CHARS = 120;

const headOf = (text: string | null): string | null =>
  text === null ? null : text.slice(0, PROMPT_HEAD_CHARS).replaceAll("\n", " ");

export const tasks: Query = {
  name: "tasks",
  summary: "list the tasks of a top-level session, each from one task prompt to the next, latest last",
  usage: "agent-record query tasks <id-prefix> [--rows <n>]",
  flags: [],
  run: (db, ctx) => {
    const prefix = ctx.arg;
    const found = sessionByPrefix(db, "tasks", prefix);
    if (found === null) {
      return {
        denominator: "0 sessions",
        columns: ["task", "at", "prompt"],
        rows: [],
        note: `no session starts with ${prefix}`,
      };
    }
    const root = rootOf(db, found);
    const starts = root.first === null ? [] : readTasks(db, root.id, root.first);
    return {
      denominator: `${starts.length} tasks of session ${root.id}`,
      columns: ["task", "at", "prompt"],
      rows: starts.map((start) => [start.id, start.at, headOf(start.text)]),
      note:
        "A task runs from one task prompt to the next. Its id is the opening message's turn id, or the message's " +
        "own id where it has none, or the session's id where the session has no user message. " +
        "query trace <id-prefix> --task <task> traces one.",
    };
  },
};
