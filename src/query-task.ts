import type { Database } from "bun:sqlite";
import { z } from "zod";
import { invariant } from "./assert";
import { readRows } from "./db";
import { refuseQuery } from "./query-contract";
import { classify, type Said } from "./query-interrupt";
import { type OpeningRow, type OwnerMessageRow, openingOf, ownerMessagesOf } from "./query-signal-record";

export const TaskId = z.string().min(1).brand<"TaskId">();

export type TaskId = z.infer<typeof TaskId>;

const TaskKey = z.string().min(1).brand<"TaskKey">();

export type TaskKey = z.infer<typeof TaskKey>;

export const taskKeyOf = (root: string, task: TaskId): TaskKey => TaskKey.parse(JSON.stringify([root, task]));

export type TaskStart = {
  readonly id: TaskId;
  readonly at: string;
  readonly ms: number;
  readonly text: string | null;
};

export type SaidRow = OwnerMessageRow & { readonly said: Said };

export const saidRows = (messages: readonly OwnerMessageRow[]): readonly SaidRow[] =>
  messages.map((message) => ({
    ...message,
    said: classify(message.text, message.agentBefore, message.midTurn),
  }));

const opensTask = (message: SaidRow): boolean => message.said.kind === "task" && message.agentBefore !== null;

const idOf = (message: OpeningRow): TaskId => TaskId.parse(message.turnId ?? message.id);

export function taskStartsOf(
  root: string,
  start: string,
  opening: OpeningRow | null,
  messages: readonly SaidRow[],
): readonly TaskStart[] {
  const opens = messages.filter(opensTask);
  const later = opens.map((message) => ({
    id: idOf(message),
    at: message.at,
    ms: Date.parse(message.at),
    text: message.text,
  }));
  const first: TaskStart = {
    id: opening === null ? TaskId.parse(root) : idOf(opening),
    at: start,
    ms: Date.parse(start),
    text: opening === null ? null : opening.text,
  };
  const openedLater = opening !== null && opens.some((message) => message.id === opening.id);
  return [...(openedLater ? [] : [first]), ...later].sort((a, b) => a.ms - b.ms);
}

export function taskAt(starts: readonly TaskStart[], at: number): TaskStart {
  const first = starts[0];
  invariant(first !== undefined, "a session has at least one task");
  return starts.reduce((found, start) => (start.ms <= at ? start : found), first);
}

export function readTasks(db: Database, root: string, start: string): readonly TaskStart[] {
  return taskStartsOf(root, start, openingOf(db, root), saidRows(ownerMessagesOf(db, root)));
}

export function taskByPrefix(starts: readonly TaskStart[], session: string, prefix: string): TaskStart {
  const found = starts.filter((start) => start.id.toLowerCase().startsWith(prefix.toLowerCase()));
  const [only, ...more] = found;
  if (only === undefined)
    throw refuseQuery("unknown_task", { session, prefix, tasks: starts.map((s) => s.id) });
  if (more.length > 0)
    throw refuseQuery("ambiguous_task", { session, prefix, matches: found.map((s) => s.id) });
  return only;
}

const RootRow = z.strictObject({
  id: z.string(),
  first: z.string().nullable(),
  branchFirst: z.string().nullable(),
});
export type RootRow = Readonly<z.infer<typeof RootRow>>;

const ROOT_OF = `WITH RECURSIVE up(id, parent, first) AS (
  SELECT id, parent_id, ts_first FROM session WHERE id = ?1
  UNION SELECT s.id, s.parent_id, s.ts_first FROM session s JOIN up ON s.id = up.parent
)
SELECT root.id, root.first, branch.first AS branchFirst
FROM up root LEFT JOIN up branch ON branch.parent = root.id
WHERE root.parent IS NULL`;

export function rootOf(db: Database, session: string): RootRow {
  const root = readRows<[string]>(db, ROOT_OF).get(RootRow, session);
  invariant(root !== null, "every session has a top-level session");
  return root;
}
