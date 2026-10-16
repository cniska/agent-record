import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { invariant } from "./assert";
import { readRows } from "./db";
import { SCHEMA_SQL } from "./db-schema";
import { ROLES } from "./ingest-session-records";
import { SAID } from "./query";
import { type Ranked, RecallCase } from "./query-recall.test-support";
import { openedHits } from "./query-recall-pairs.test-support";
import { docOf, gramOf, textOf, withTokenizer } from "./query-recall-scrub.test-support";
import { termsOf } from "./query-search";

const CANDIDATES_PER_CASE = 10;
const NO_TOKEN = "-";
const FIXTURE_FILE = "/fixture.jsonl";

export const RECALL_FIXTURE = join(import.meta.dir, "query-recall.fixture.json");

const FixtureMessage = z.strictObject({
  id: z.string(),
  at: z.string(),
  role: z.enum(ROLES),
  length: z.int().nonnegative(),
  spaced: z.boolean(),
  grams: z.array(z.tuple([z.string(), z.int().positive()]).readonly()).readonly(),
});

export const Fixture = z.strictObject({
  cases: z.array(RecallCase).readonly(),
  messages: z.array(FixtureMessage).readonly(),
});

export type Fixture = z.infer<typeof Fixture>;

export function readFixture(): Fixture {
  const parsed: unknown = JSON.parse(readFileSync(RECALL_FIXTURE, "utf8"));
  return Fixture.parse(parsed);
}

const linesOf = (items: readonly unknown[]): string => items.map((item) => JSON.stringify(item)).join(",\n");

export function writeFixture(fixture: Fixture): void {
  writeFileSync(
    RECALL_FIXTURE,
    `{"cases":[\n${linesOf(fixture.cases)}\n],\n"messages":[\n${linesOf(fixture.messages)}\n]}\n`,
  );
}

const CallRow = z.strictObject({ session: z.string(), at: z.string(), command: z.string() });

const IdRow = z.strictObject({ id: z.string() });

const LiveMessage = z.strictObject({ id: z.string(), at: z.string(), role: z.string(), text: z.string() });

export function liveCases(db: Database): readonly RecallCase[] {
  const calls = readRows(
    db,
    `SELECT session_id AS session, ts_call AS at, command FROM tool_call
     WHERE ts_call IS NOT NULL AND (command LIKE '%query search%' OR command LIKE '%query thread%')
     ORDER BY session_id, ts_call, src_line_call`,
  ).all(CallRow);
  const expectedOf = readRows<[string, string, string, string]>(
    db,
    `SELECT m.id FROM message m
     WHERE m.session_id LIKE ?1 || '%' AND substr(m.ts, 1, length(?2)) = ?2 AND m.ts < ?3
       AND m.text IS NOT NULL AND ${SAID}
       AND EXISTS (SELECT 1 FROM message_fts WHERE message_fts MATCH ?4 AND message_fts.rowid = m.rowid)
     ORDER BY m.id`,
  );
  const unique = new Map<string, Omit<RecallCase, "id">>();
  for (const hit of openedHits(calls)) {
    const match = termsOf(hit.words)
      .terms.map((term) => term.quoted)
      .join(" OR ");
    if (match === "") continue;
    const expected = expectedOf.all(IdRow, hit.prefix, hit.at, hit.searchedAt, match).map(({ id }) => id);
    const key = [hit.searchedAt, hit.words, ...expected].join("\n");
    if (expected.length > 0 && !unique.has(key))
      unique.set(key, { searchedAt: hit.searchedAt, words: hit.words, expected });
  }
  return [...unique.values()].map((recallCase, index) => ({ id: index + 1, ...recallCase }));
}

export function fixtureOf(db: Database, cases: readonly RecallCase[], ranked: readonly Ranked[]): Fixture {
  const messageOf = readRows<[string]>(
    db,
    "SELECT id, ts AS at, role, text FROM message WHERE id = ? AND text IS NOT NULL",
  );
  const order = new Map<string, string>();
  for (const [index, recallCase] of cases.entries()) {
    const candidates = (ranked[index] ?? []).slice(0, CANDIDATES_PER_CASE).flat();
    for (const id of [...candidates, ...recallCase.expected]) {
      if (!order.has(id)) order.set(id, `m${order.size + 1}`);
    }
  }
  return withTokenizer((tokens) => {
    const codes = new Map<string, string>();
    const codeOf = (token: string): string => {
      const code = codes.get(token) ?? `w${codes.size + 1}`;
      codes.set(token, code);
      return code;
    };
    const words = cases.map((recallCase) =>
      recallCase.words
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => gramOf(tokens(word).map(codeOf)) || NO_TOKEN),
    );
    const grams = [...new Set(words.flat())].filter((gram) => gram !== NO_TOKEN);
    const messages = [...order].map(([liveId, id]) => {
      const live = messageOf.get(LiveMessage, liveId);
      invariant(live !== null, `a ranked message is in the record: ${liveId}`);
      const doc = docOf(
        tokens(live.text).map((token) => codes.get(token) ?? null),
        grams,
      );
      invariant(doc !== null, `a message's query words lay out exactly: ${liveId}`);
      return { id, at: live.at, role: z.enum(ROLES).parse(live.role), ...doc };
    });
    return {
      cases: cases.map((recallCase, index) => ({
        id: recallCase.id,
        searchedAt: recallCase.searchedAt,
        words: (words[index] ?? []).join(" "),
        expected: recallCase.expected.map((liveId) => {
          const id = order.get(liveId);
          invariant(id !== undefined, `an expected message is in the fixture: ${liveId}`);
          return id;
        }),
      })),
      messages,
    };
  });
}

export function fixtureRecord(fixture: Fixture): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    `INSERT INTO source_file (path, tool, kind, session_id) VALUES (?, 'claude', 'transcript', 'fixture')`,
    [FIXTURE_FILE],
  );
  const session = db.query<unknown, [string, string]>(
    "INSERT INTO session (id, tool, ts_first, ts_last) VALUES (?1, 'claude', ?2, ?2)",
  );
  const message = db.query<unknown, [string, string, string, string, string, number]>(
    "INSERT INTO message (id, session_id, ts, role, text, src_file, src_line) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6)",
  );
  fixture.messages.forEach((row, index) => {
    session.run(row.id, row.at);
    message.run(row.id, row.at, row.role, textOf(row), FIXTURE_FILE, index + 1);
  });
  return db;
}
