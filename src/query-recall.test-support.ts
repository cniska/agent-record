import type { Database } from "bun:sqlite";
import { z } from "zod";
import { invariant } from "./assert";
import { readRows } from "./db";
import { SAID } from "./query";
import { search } from "./query-search";

const RECALL_DEPTH = 5;

const IdRow = z.strictObject({ id: z.string() });

const RANKED_ROWS = 2000;

export const RecallCase = z.strictObject({
  id: z.int().positive(),
  searchedAt: z.string(),
  words: z.string(),
  expected: z.array(z.string()).min(1).readonly(),
});

export type RecallCase = z.infer<typeof RecallCase>;

export type Ranked = readonly (readonly string[])[];

type Miss = { readonly id: number; readonly rank: number | null };

export type Recall = { readonly found: number; readonly cases: number; readonly missed: readonly Miss[] };

function rankedBefore(db: Database, words: string, before: string): Ranked {
  const result = search.run(db, { arg: words, flags: {}, home: "", maxRows: RANKED_ROWS });
  const column = (name: string): number => {
    const index = result.columns.indexOf(name);
    invariant(index >= 0, `search returns a ${name} column`);
    return index;
  };
  const [session, at, role] = [column("session"), column("at"), column("role")];
  const idsAt = readRows<[string, string, string]>(
    db,
    `SELECT m.id FROM message m WHERE m.session_id = ? AND m.ts = ? AND m.role = ? AND m.text IS NOT NULL AND ${SAID}
     ORDER BY m.id`,
  );
  const seen = new Set<string>();
  const ranked: (readonly string[])[] = [];
  for (const row of result.rows) {
    const hit = { session: String(row[session]), at: String(row[at]), role: String(row[role]) };
    const key = `${hit.session}\n${hit.at}\n${hit.role}`;
    if (hit.at >= before || seen.has(key)) continue;
    seen.add(key);
    ranked.push(idsAt.all(IdRow, hit.session, hit.at, hit.role).map(({ id }) => id));
  }
  return ranked;
}

export function rankOf(ranked: Ranked, expected: readonly string[]): number | null {
  const index = ranked.findIndex((ids) => ids.some((id) => expected.includes(id)));
  return index === -1 ? null : index + 1;
}

export function rankedCases(db: Database, cases: readonly RecallCase[]): readonly Ranked[] {
  return cases.map((recallCase) => rankedBefore(db, recallCase.words, recallCase.searchedAt));
}

export function recallOf(cases: readonly RecallCase[], ranked: readonly Ranked[]): Recall {
  const ranks = cases.map((recallCase, index) => ({
    id: recallCase.id,
    rank: rankOf(ranked[index] ?? [], recallCase.expected),
  }));
  const missed = ranks.filter(({ rank }) => rank === null || rank > RECALL_DEPTH);
  return { found: cases.length - missed.length, cases: cases.length, missed };
}

export function recallAt5(db: Database, cases: readonly RecallCase[]): Recall {
  return recallOf(cases, rankedCases(db, cases));
}
