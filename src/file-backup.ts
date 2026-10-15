import { constants, copyFileSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const BACKUP_SUFFIX = ".agent-record-backup";
const FIRST_NUMBER = 2;
const NUMBERED = /^-(\d+)$/;

export function nextBackupPath(source: string): string {
  const base = `${source}${BACKUP_SUFFIX}`;
  let path = base;
  let number = FIRST_NUMBER;
  while (lstatSync(path, { throwIfNoEntry: false })) {
    path = `${base}-${number}`;
    number += 1;
  }
  return path;
}

export function copyBackup(source: string): string {
  const backup = nextBackupPath(source);
  copyFileSync(source, backup, constants.COPYFILE_EXCL);
  return backup;
}

function backupNumber(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (rest === "") return FIRST_NUMBER - 1;
  const numbered = NUMBERED.exec(rest);
  return numbered === null ? null : Number(numbered[1]);
}

export type Backup = { readonly path: string; readonly bytes: number };

export function backupsOf(source: string): readonly Backup[] {
  const dir = dirname(source);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const prefix = `${basename(source)}${BACKUP_SUFFIX}`;
  return readdirSync(dir)
    .flatMap((name) => {
      const number = backupNumber(name, prefix);
      if (number === null) return [];
      const path = join(dir, name);
      const stats = statSync(path, { throwIfNoEntry: false });
      return stats === undefined ? [] : [{ path, bytes: stats.size, number }];
    })
    .sort((a, b) => a.number - b.number)
    .map(({ path, bytes }) => ({ path, bytes }));
}

export function removeBackupsBut(source: string, kept: string): void {
  for (const { path } of backupsOf(source)) if (path !== kept) rmSync(path, { force: true });
}
