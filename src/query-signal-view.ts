import type { Database } from "bun:sqlite";
import { readSignalRecord } from "./query-signal-record";
import type { Signal } from "./query-signals";
import { type Timeline, timelineOf } from "./query-timeline";

const HOME_SIGN = "~";

export function viewRecord(db: Database): {
  readonly timeline: Timeline;
  readonly labels: ReadonlyMap<string, string>;
} {
  const record = readSignalRecord(db);
  return { timeline: timelineOf(record), labels: record.labels };
}

export function repoShown(repo: string | null, home: string): string | null {
  if (repo === null) return null;
  return repo === home || repo.startsWith(`${home}/`) ? `${HOME_SIGN}${repo.slice(home.length)}` : repo;
}

export const described = (signal: Signal): string => `${signal.name}: ${signal.value}`;
