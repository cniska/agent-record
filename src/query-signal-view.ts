import type { Database } from "bun:sqlite";
import { refuseQuery } from "./query-contract";
import { readSignalRecord } from "./query-signal-record";
import type { Signal } from "./query-signals";
import { type Placed, type TaskKey, type Timeline, timelineOf } from "./query-timeline";

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

export function tasksLoading(timeline: Timeline, skill: string): ReadonlySet<TaskKey> {
  const loads = timeline.skillLoads.filter((load) => load.skill === skill);
  if (loads.length === 0) {
    const skills = [...new Set(timeline.skillLoads.map((load) => load.skill))].sort();
    throw refuseQuery("unknown_skill", { skill, skills });
  }
  return new Set(loads.map((load) => load.task));
}

export const inScope =
  (scope: ReadonlySet<TaskKey> | null) =>
  (placed: Placed): boolean =>
    scope === null || scope.has(placed.task);
