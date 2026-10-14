import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./db-schema";

const FILLER = "x";

const GRAM_JOIN = "-";

type Doc = {
  readonly length: number;
  readonly spaced: boolean;
  readonly grams: readonly (readonly [string, number])[];
};

export function withTokenizer<T>(use: (tokens: (text: string) => readonly string[]) => T): T {
  const scratch = new Database(":memory:");
  try {
    scratch.run(SCHEMA_SQL);
    scratch.run("CREATE VIRTUAL TABLE token USING fts5vocab(message_fts, 'instance')");
    const insert = scratch.query<unknown, [string]>(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('tokenized', 'tokenized', '', 'user', ?, '', 0)`,
    );
    const read = scratch.query<{ term: string }, []>("SELECT term FROM token ORDER BY offset");
    return use((text) => {
      scratch.run("DELETE FROM message");
      insert.run(text);
      return read.all().map(({ term }) => term);
    });
  } finally {
    scratch.close();
  }
}

export function gramOf(codes: readonly string[]): string {
  return codes.join(GRAM_JOIN);
}

const partsOf = (gram: string): readonly string[] => gram.split(GRAM_JOIN);

function occurrences(tokens: readonly (string | null)[], parts: readonly string[]): number {
  let count = 0;
  for (let start = 0; start + parts.length <= tokens.length; start += 1) {
    if (parts.every((part, offset) => tokens[start + offset] === part)) count += 1;
  }
  return count;
}

function countsOf(
  tokens: readonly (string | null)[],
  grams: readonly string[],
): readonly (readonly [string, number])[] {
  return grams.map((gram) => [gram, occurrences(tokens, partsOf(gram))] as const);
}

export function textOf(doc: Doc): string {
  const tokens = doc.grams.flatMap(([gram, count]) =>
    Array.from({ length: count }, () => (doc.spaced ? [...partsOf(gram), FILLER] : partsOf(gram))).flat(),
  );
  return [...tokens, ...Array(Math.max(0, doc.length - tokens.length)).fill(FILLER)].join(" ");
}

function layoutOf(
  original: readonly (readonly [string, number])[],
): readonly (readonly [string, number])[] | null {
  const phrases = original.filter(([gram, count]) => count > 0 && partsOf(gram).length > 1);
  const inPhrases = new Map<string, number>();
  for (const [gram, count] of phrases) {
    for (const part of partsOf(gram)) inPhrases.set(part, (inPhrases.get(part) ?? 0) + count);
  }
  const singles = original
    .filter(([gram, count]) => count > 0 && partsOf(gram).length === 1)
    .map(([gram, count]) => [gram, count - (inPhrases.get(gram) ?? 0)] as const);
  if (singles.some(([, count]) => count < 0)) return null;
  return [...phrases, ...singles.filter(([, count]) => count > 0)];
}

export function docOf(tokens: readonly (string | null)[], grams: readonly string[]): Doc | null {
  const original = countsOf(tokens, grams);
  const layout = layoutOf(original);
  if (layout === null) return null;
  const exact = (doc: Doc): boolean => {
    const rebuilt = textOf(doc).split(" ");
    return (
      rebuilt.length === tokens.length &&
      countsOf(rebuilt, grams).every(([, count], index) => count === original[index]?.[1])
    );
  };
  return (
    [true, false].map((spaced) => ({ length: tokens.length, spaced, grams: layout })).find(exact) ?? null
  );
}
