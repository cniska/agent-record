import type { Database } from "bun:sqlite";
import { refuseQuery } from "./query-contract";
import { readSignalRecord } from "./query-signal-record";
import type { Signal } from "./query-signals";
import { type Placed, type SkillLoaded, type TaskKey, type Timeline, timelineOf } from "./query-timeline";

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

export type SkillScope = {
  readonly skill: string;
  readonly loads: readonly SkillLoaded[];
  readonly tasks: ReadonlySet<TaskKey>;
  readonly shown: string;
};

export function skillScope(timeline: Timeline, skill: string | undefined): SkillScope | null {
  if (skill === undefined) return null;
  const loads = timeline.skillLoads.filter((load) => load.skill === skill);
  if (loads.length === 0) {
    const skills = [...new Set(timeline.skillLoads.map((load) => load.skill))].sort();
    throw refuseQuery("unknown_skill", { skill, skills });
  }
  return {
    skill,
    loads,
    tasks: new Set(loads.map((load) => load.task)),
    shown: `in the tasks that loaded ${skill}`,
  };
}

export const scoped = <Item extends Placed>(
  scope: SkillScope | null,
  items: readonly Item[],
): readonly Item[] => (scope === null ? items : items.filter((item) => scope.tasks.has(item.task)));
