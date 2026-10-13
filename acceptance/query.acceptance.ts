import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import {
  type Home,
  QUERY_RESULT,
  refused,
  removeScratch,
  runCli,
  scratchHome,
  succeeded,
  syncedHome,
  USAGE_ENTRY,
  withFixtures,
} from "./cli";

afterEach(removeScratch);

const syncedFixtureHome = (): Home =>
  syncedHome(withFixtures(scratchHome(), ["claude/-Users-x-code-demo/long-session.jsonl"]));

test("AC-13 query list names every query with its usage and summary", () => {
  const result = succeeded(
    runCli(scratchHome(), ["query", "list"]),
    "query",
    z.strictObject({ queries: z.array(USAGE_ENTRY) }),
  );
  expect(result.queries.map(({ name, usage }) => ({ name, usage }))).toEqual([
    { name: "prior-art", usage: 'agent-record query prior-art "<path fragment>" [--rows <n>]' },
    { name: "search", usage: 'agent-record query search "<words>" [--rows <n>]' },
    { name: "thread", usage: "agent-record query thread <id-prefix> [--at <ts>] [--rows <n>]" },
  ]);
  for (const { summary } of result.queries) expect(summary).not.toBe("");
});

test("AC-13 an unknown query is refused naming query list", () => {
  const error = refused(runCli(scratchHome(), ["query", "nope", "x"]), "query");
  expect({ code: error.code, resolve: error.resolve }).toEqual({
    code: "unknown_query",
    resolve: "agent-record query list",
  });
});

test("AC-13 --rows 0 is refused as not a count", () => {
  const error = refused(runCli(scratchHome(), ["query", "thread", "long-session", "--rows", "0"]), "query");
  expect(error.code).toBe("not_a_count");
});

test("AC-13 a query with more rows than the default prints the default count and the more note", () => {
  const home = syncedFixtureHome();
  const cut = succeeded(runCli(home, ["query", "thread", "long-session"]), "query", QUERY_RESULT);
  expect({ rows: cut.rows.length, more: cut.more }).toEqual({
    rows: 40,
    more: "more rows than 40; --rows <n> to widen",
  });
  expect(cut.denominator).not.toBe("");

  const widened = succeeded(
    runCli(home, ["query", "thread", "long-session", "--rows", "45"]),
    "query",
    QUERY_RESULT,
  );
  expect({ rows: widened.rows.length, more: widened.more }).toEqual({ rows: 45, more: null });
});

test("AC-17 sql answers a SELECT with columns and rows in a query's shape", () => {
  const result = succeeded(
    runCli(syncedHome(), ["sql", "select 1 as n, 'x' as s, null as z"]),
    "sql",
    QUERY_RESULT,
  );
  expect({ columns: result.columns, rows: result.rows, more: result.more }).toEqual({
    columns: ["n", "s", "z"],
    rows: [[1, "x", null]],
    more: null,
  });
});

test("AC-17 sql refuses a write, leaving the record unchanged", () => {
  const home = syncedFixtureHome();
  const count = ["sql", "select count(*) as n from session"];
  const before = succeeded(runCli(home, count), "sql", QUERY_RESULT).rows;
  expect(before).not.toEqual([[0]]);
  const error = refused(
    runCli(home, ["sql", "insert into session (id, tool) select id || '-copy', tool from session"]),
    "sql",
  );
  expect(error.code).toBe("sql_writes");
  expect(succeeded(runCli(home, count), "sql", QUERY_RESULT).rows).toEqual(before);
});

test("AC-17 sql refuses a syntax error with SQLite's reason", () => {
  const error = refused(runCli(syncedHome(), ["sql", "selec"]), "sql");
  expect({ code: error.code, detail: error.meta.detail }).toEqual({
    code: "sql_invalid",
    detail: 'near "selec": syntax error',
  });
  expect(error.message).toContain('near "selec": syntax error');
});

test("AC-17 sql refuses a column named twice, naming the column", () => {
  const error = refused(runCli(syncedHome(), ["sql", "select 1 as a, 2 as a"]), "sql");
  expect({ code: error.code, column: error.meta.column }).toEqual({
    code: "sql_columns_repeated",
    column: "a",
  });
});

test("AC-17 sql refuses a blob, naming hex()", () => {
  const error = refused(runCli(syncedHome(), ["sql", "select x'00' as b"]), "sql");
  expect({ code: error.code, resolve: error.resolve }).toEqual({
    code: "sql_blob",
    resolve: "select hex(b) instead",
  });
});

test.todo("AC-14 search ranks said messages by matched words, skips skill bodies, names unmatched and dropped words, and a hit opens in thread", () => {});
test.todo("AC-15 thread reads a session whole or around a time with the counts outside, refuses an ambiguous prefix and answers an unknown one empty", () => {});
test.todo("AC-16 prior-art folds worktrees onto their checkout, newest first, and says when it ranked only some", () => {});
test.todo("AC-23 a query answers beside a writer and is refused as busy under an exclusive lock", () => {});
