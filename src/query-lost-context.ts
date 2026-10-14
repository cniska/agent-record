import type { ReadRow, TimedRow } from "./query-signal-record";

export type Reread = { readonly path: string; readonly at: string };

type Compacted = TimedRow & { readonly rereads: readonly Reread[] };

const ms = (at: string): number => Date.parse(at);

function rereadsOf(reads: readonly ReadRow[], from: number, at: number, until: number): readonly Reread[] {
  const before = new Set(reads.filter((read) => ms(read.at) >= from && ms(read.at) < at).map((r) => r.path));
  const seen = new Set<string>();
  return reads.flatMap((read) => {
    const time = ms(read.at);
    if (time < at || time >= until || !before.has(read.path) || seen.has(read.path)) return [];
    seen.add(read.path);
    return [{ path: read.path, at: read.at }];
  });
}

export function rereadsAfterCompactions(
  compactions: readonly TimedRow[],
  reads: readonly ReadRow[],
): readonly Compacted[] {
  const readsOf = Map.groupBy(reads, (read) => read.sessionId);
  return [...Map.groupBy(compactions, (compaction) => compaction.sessionId).values()].flatMap((list) =>
    list.map((compaction, index) => {
      const previous = list[index - 1];
      const next = list[index + 1];
      const rereads = rereadsOf(
        readsOf.get(compaction.sessionId) ?? [],
        previous === undefined ? Number.NEGATIVE_INFINITY : ms(previous.at),
        ms(compaction.at),
        next === undefined ? Number.POSITIVE_INFINITY : ms(next.at),
      );
      return { ...compaction, rereads };
    }),
  );
}
