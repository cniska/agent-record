import { constants, copyFileSync, mkdirSync, renameSync, type Stats, statSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { unreachable } from "./assert";

export const PART_SUFFIX = ".part";

export type SourceTime = "modified" | "changed";

const STAMP_ROUND_TRIP_MS = 0.001;

export function sameStamp(copy: Stats, source: Stats, time: SourceTime): boolean {
  if (copy.size !== source.size) return false;
  switch (time) {
    case "modified":
      return Math.trunc(copy.mtimeMs) === Math.trunc(source.mtimeMs);
    case "changed":
      return Math.abs(copy.mtimeMs - source.ctimeMs) < STAMP_ROUND_TRIP_MS;
    default:
      return unreachable(time);
  }
}

export function stampLike(path: string, source: Stats, time: SourceTime): void {
  switch (time) {
    case "modified": {
      const at = new Date(Math.trunc(source.mtimeMs));
      utimesSync(path, at, at);
      return;
    }
    case "changed": {
      const at = source.ctimeMs / 1000;
      utimesSync(path, at, at);
      return;
    }
  }
}

function doNothing(): void {}

export function copyWhole(
  from: string,
  to: string,
  fromStat: Stats,
  time: SourceTime,
  beforeRename: () => void = doNothing,
): number {
  mkdirSync(dirname(to), { recursive: true });
  const part = `${to}${PART_SUFFIX}`;
  copyFileSync(from, part, constants.COPYFILE_FICLONE);
  stampLike(part, fromStat, time);
  beforeRename();
  renameSync(part, to);
  return statSync(to).size;
}

type BeforeReplace = (fromStat: Stats, toStat: Stats, to: string) => void;

export function copyIfChanged(
  from: string,
  to: string,
  time: SourceTime,
  beforeReplace: BeforeReplace = doNothing,
): number | null {
  const fromStat = statSync(from);
  const toStat = statSync(to, { throwIfNoEntry: false });
  if (!toStat) return copyWhole(from, to, fromStat, time);
  if (sameStamp(toStat, fromStat, time)) return null;
  return copyWhole(from, to, fromStat, time, () => beforeReplace(fromStat, toStat, to));
}
