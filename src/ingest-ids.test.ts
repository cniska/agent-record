import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
  SessionId,
  sessionIdOf,
  subagentSessionId,
  subagentSessionSql,
  topLevelSessionSql,
} from "./ingest-ids";

const db = new Database(":memory:");
afterAll(() => db.close());

const TOP = SessionId.parse("1f053f2d-dd38-428f-ac48-341208f4c29d");
const SUBAGENT = subagentSessionId("a27e5ad07bc47dd59", TOP);

const asked = (sql: string, id: string) =>
  db.query<{ v: unknown }, [string]>(`SELECT ${sql} AS v`).get(id)?.v;

test("a subagent's session id is its agent id at its top-level session's", () => {
  expect(SUBAGENT).toBe(SessionId.parse("a27e5ad07bc47dd59@1f053f2d-dd38-428f-ac48-341208f4c29d"));
});

test("a subagent's session id gives back its top-level session in SQL, and a top-level id itself", () => {
  expect(asked(topLevelSessionSql("?1"), SUBAGENT)).toBe("1f053f2d-dd38-428f-ac48-341208f4c29d");
  expect(asked(topLevelSessionSql("?1"), TOP)).toBe("1f053f2d-dd38-428f-ac48-341208f4c29d");
});

test("SQL tells a subagent's session id from a top-level one", () => {
  expect(asked(subagentSessionSql("?1"), SUBAGENT)).toBe(1);
  expect(asked(subagentSessionSql("?1"), TOP)).toBe(0);
});

test("a top-level session id read from a tool's files holds no @", () => {
  expect(sessionIdOf("1f053f2d-dd38-428f-ac48-341208f4c29d")).toBe(TOP);
  expect(sessionIdOf("a27e5ad07bc47dd59@1f053f2d-dd38-428f-ac48-341208f4c29d")).toBeNull();
});
