import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import {
  type Home,
  holdingRecord,
  QUERY_RESULT,
  refused,
  removeScratch,
  runCli,
  scratchDirOutsideTemp,
  scratchHome,
  scratchRepo,
  scratchWorktree,
  succeeded,
  sync,
  syncedHome,
  USAGE_ENTRY,
  withFixtures,
} from "./cli";
import { CLAUDE, CODEX, CODEX_OVERCACHED, LONG, REPO_SESSION, WORKTREE_SESSION } from "./fixture-names";

afterEach(removeScratch);

const query = (home: Home, args: readonly string[]) =>
  succeeded(runCli(home, ["query", ...args]), "query", QUERY_RESULT);

const syncedFixtureHome = (): Home => syncedHome(withFixtures(scratchHome(), [LONG]));

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
  const cut = query(home, ["thread", "long-session"]);
  expect({ rows: cut.rows.length, more: cut.more }).toEqual({
    rows: 40,
    more: "more rows than 40; --rows <n> to widen",
  });
  expect(cut.denominator).not.toBe("");

  const widened = query(home, ["thread", "long-session", "--rows", "45"]);
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

test("AC-14 search ranks said messages by matched words, skips skill bodies, names unmatched and dropped words, and a hit opens in thread", () => {
  const home = syncedHome(withFixtures(scratchHome(), [CLAUDE]));
  const absent = Array.from({ length: 14 }, (_, n) => `absent${n}`);
  const result = query(home, ["search", ["add", "parser", "build", "Base", ...absent].join(" ")]);

  expect(result).toEqual({
    denominator:
      "keywords over 3 of 6 messages that carry text anyone said; ranked by how many of the 16 terms matched, " +
      "ties broken by relevance then recency. Only the first 16 words were searched; 2 more were dropped. " +
      `These terms matched nothing anyone said: Base, ${absent.slice(0, 12).join(", ")}. ` +
      "`agent-record query thread <session> --at <at>` reads the exchange a hit sits in.",
    columns: ["session", "at", "role", "project", "terms", "text"],
    rows: [
      [
        "claude-session",
        "2026-09-16T10:01:00.000Z",
        "user",
        "/Users/x/code/demo",
        "2/16",
        "[add] the [parser]",
      ],
      [
        "claude-session",
        "2026-09-16T10:02:00.000Z",
        "assistant",
        "/Users/x/code/demo",
        "1/16",
        "Loading the [build] skill.",
      ],
    ],
    more: null,
    note: null,
  });

  const [session, at] = result.rows[0] ?? [];
  const hit = query(home, ["thread", String(session), "--at", String(at), "--rows", "1"]);
  expect(hit.rows).toEqual([["2026-09-16T10:01:00.000Z", "user", "", "add the parser"]]);
});

test("AC-15 thread reads a session whole or around a time with the counts outside, refuses an ambiguous prefix and answers an unknown one empty", () => {
  const home = syncedHome(withFixtures(scratchHome(), [LONG, CODEX, CODEX_OVERCACHED]));
  const step = (n: number) => [
    `2026-09-16T10:${String(n).padStart(2, "0")}:00.000Z`,
    "user",
    "",
    `parser step ${n}`,
  ];

  const whole = query(home, ["thread", "long", "--rows", "45"]);
  expect({ columns: whole.columns, rows: whole.rows, more: whole.more }).toEqual({
    columns: ["at", "role", "skill", "text"],
    rows: Array.from({ length: 45 }, (_, n) => step(n)),
    more: null,
  });
  expect(whole.denominator).toBe("session long-session: 45 messages anyone said, 0 denials and 0 tool calls");

  const around = query(home, ["thread", "long", "--at", "2026-09-16T10:20:00.000Z", "--rows", "4"]);
  expect({ rows: around.rows, denominator: around.denominator }).toEqual({
    rows: [step(19), step(20), step(21), step(22)],
    denominator:
      "session long-session: 45 messages anyone said, 0 denials and 0 tool calls, centered on " +
      "2026-09-16T10:20:00.000Z; 19 earlier and 22 later rows not shown, --rows <n> to widen",
  });

  const ambiguous = refused(runCli(home, ["query", "thread", "0199a000"]), "query");
  expect({ code: ambiguous.code, matches: ambiguous.meta.matches }).toEqual({
    code: "ambiguous_session",
    matches: ["0199a000-0000-7000-8000-000000000001", "0199a000-0000-7000-8000-000000000002"],
  });

  const unknown = query(home, ["thread", "nosuch"]);
  expect({ denominator: unknown.denominator, rows: unknown.rows, note: unknown.note }).toEqual({
    denominator: "0 sessions",
    rows: [],
    note: "no session starts with nosuch",
  });
});

test("AC-16 prior-art folds worktrees onto their checkout, newest first, and says when it ranked only some", () => {
  const repo = scratchRepo(join(scratchDirOutsideTemp(), "app"), "git@github.com:acme/app.git", [
    { subject: "feat: add the a parser", file: "src/parse-a.ts", at: "2026-09-10T10:00:00Z" },
    { subject: "feat: add the b parser", file: "src/parse-b.ts", at: "2026-09-11T10:00:00Z" },
    { subject: "feat: add the c parser", file: "src/parse-c.ts", at: "2026-09-12T10:00:00Z" },
    { subject: "feat: add the d parser", file: "src/parse-d.ts", at: "2026-09-13T10:00:00Z" },
  ]);
  const worktree = join(repo, ".claude", "worktrees", "side");
  scratchWorktree(repo, worktree, {
    subject: "feat: add the e parser",
    file: "src/parse-e.ts",
    at: "2026-09-14T10:00:00Z",
  });
  const home = withFixtures(withFixtures(scratchHome(), [REPO_SESSION], repo), [WORKTREE_SESSION], worktree);
  sync(home);

  const result = query(home, ["prior-art", "src/parse-"]);
  expect(result.rows.map(([file, where, commits, , authors]) => [file, where, commits, authors])).toEqual([
    [join(repo, "src", "parse-e.ts"), "acme/app", 1, 1],
    [join(repo, "src", "parse-d.ts"), "acme/app", 1, 1],
    [join(repo, "src", "parse-c.ts"), "acme/app", 1, 1],
  ]);
  expect(result.denominator).toBe(
    '5 tracked files match "src/parse-", in 1 of 1 checkouts indexed; the 3 most recently touched under each where are ranked',
  );
});
test("AC-23 a query answers beside a writer and is refused as busy under an exclusive lock", () => {
  const home = syncedFixtureHome();
  const args = ["search", "parser"];
  const answered = query(home, args);

  expect(holdingRecord(home, "write", () => query(home, args))).toEqual(answered);
  const error = holdingRecord(home, "exclusive", () => refused(runCli(home, ["query", ...args]), "query"));
  expect({ kind: error.kind, code: error.code, meta: error.meta, resolve: error.resolve }).toEqual({
    kind: "refusal",
    code: "record_busy",
    meta: { path: home.record },
    resolve: "run this again; if it keeps failing, close whatever holds the file",
  });
});
