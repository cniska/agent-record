import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { readRows } from "./db";
import {
  SessionId,
  sessionIdOf,
  subagentSessionId,
  subagentSessionSql,
  topLevelSessionSql,
} from "./ingest-ids";

const db = new Database(":memory:");
afterAll(() => db.close());

const TOP = SessionId.parse("33333333-4444-5555-6666-777777777777");
const SUBAGENT = subagentSessionId("a3333333333333333", TOP);

const asked = (sql: string, id: string) =>
  readRows<[string]>(db, `SELECT ${sql} AS v`).get(z.strictObject({ v: z.unknown() }), id)?.v;

test("a subagent's session id is its agent id at its top-level session's", () => {
  expect(SUBAGENT).toBe(SessionId.parse("a3333333333333333@33333333-4444-5555-6666-777777777777"));
});

test("a subagent's session id gives back its top-level session in SQL, and a top-level id itself", () => {
  expect(asked(topLevelSessionSql("?1"), SUBAGENT)).toBe("33333333-4444-5555-6666-777777777777");
  expect(asked(topLevelSessionSql("?1"), TOP)).toBe("33333333-4444-5555-6666-777777777777");
});

test("SQL tells a subagent's session id from a top-level one", () => {
  expect(asked(subagentSessionSql("?1"), SUBAGENT)).toBe(1);
  expect(asked(subagentSessionSql("?1"), TOP)).toBe(0);
});

test("a top-level session id read from a tool's files holds no @", () => {
  expect(sessionIdOf("33333333-4444-5555-6666-777777777777")).toBe(TOP);
  expect(sessionIdOf("a3333333333333333@33333333-4444-5555-6666-777777777777")).toBeNull();
});
