import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { Count, readRows, writeTransaction } from "./db";
import { subagentSessionSql, topLevelSessionSql } from "./ingest-ids";

const SPAWNED_IN_ITS_TASK = `caller.id = child.spawn_call
  AND caller.session_id <> child.id
  AND ${topLevelSessionSql("caller.session_id")} = ${topLevelSessionSql("child.id")}`;

const LINK_TO_SPAWNING_SESSION = `UPDATE session AS child SET parent_id = caller.session_id
  FROM tool_call AS caller
  WHERE ${SPAWNED_IN_ITS_TASK} AND child.parent_id IS NOT caller.session_id`;

const COUNT_UNLINKED = `SELECT count(*) AS n FROM session AS child
  WHERE ${subagentSessionSql("child.id")}
    AND NOT EXISTS (SELECT 1 FROM tool_call AS caller WHERE ${SPAWNED_IN_ITS_TASK})`;

export function linkSpawnedSubagents(db: Database): number {
  writeTransaction(db, () => db.run(LINK_TO_SPAWNING_SESSION));
  const row = readRows(db, COUNT_UNLINKED).get(Count);
  invariant(row !== null, "a count returns one row");
  return row.n;
}
