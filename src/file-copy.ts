import { constants, copyFileSync, mkdirSync, renameSync, type Stats, statSync, utimesSync } from "node:fs";
import { dirname } from "node:path";

export const PART_SUFFIX = ".part";

export function sameStamp(a: Stats, b: Stats): boolean {
  return a.size === b.size && Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs);
}

export function stampLike(path: string, source: Stats): void {
  const at = new Date(Math.trunc(source.mtimeMs));
  utimesSync(path, at, at);
}

function doNothing(): void {}

export function copyWhole(
  from: string,
  to: string,
  fromStat: Stats,
  beforeRename: () => void = doNothing,
): number {
  mkdirSync(dirname(to), { recursive: true });
  const part = `${to}${PART_SUFFIX}`;
  copyFileSync(from, part, constants.COPYFILE_FICLONE);
  stampLike(part, fromStat);
  beforeRename();
  renameSync(part, to);
  return statSync(to).size;
}

type BeforeReplace = (fromStat: Stats, toStat: Stats, to: string) => void;

export function copyIfChanged(
  from: string,
  to: string,
  beforeReplace: BeforeReplace = doNothing,
): number | null {
  const fromStat = statSync(from);
  const toStat = statSync(to, { throwIfNoEntry: false });
  if (!toStat) return copyWhole(from, to, fromStat);
  if (sameStamp(toStat, fromStat)) return null;
  return copyWhole(from, to, fromStat, () => beforeReplace(fromStat, toStat, to));
}
