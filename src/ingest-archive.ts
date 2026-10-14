import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { invariant } from "./assert";
import type { Env } from "./env";
import { isEnvironmentError } from "./error-read";
import { copyIfChanged, copyWhole, sameStamp, stampLike } from "./file-copy";
import { type Failure, refuseIngest } from "./ingest-contract";
import { readAt } from "./ingest-read-at";
import { scan } from "./ingest-scan";
import { SESSION_SOURCES, type SessionSource } from "./ingest-sources";
import { TOOLS, type Tool } from "./ingest-tools";
import { archiveDir } from "./paths";

const TAIL_BYTES = 4096;
const COMPARE_CHUNK_BYTES = 1 << 20;

export type ArchiveReport = { readonly files: number; readonly bytes: number };

type Archiver = (live: string, copy: string) => number;

const UNTOUCHED = 0;

export function archiveRootOf(tool: Tool, env: Env): string {
  return join(archiveDir(env), tool);
}

function rebase(fromRoot: string, toRoot: string, path: string): string | null {
  if (!path.startsWith(fromRoot + sep)) return null;
  return join(toRoot, relative(fromRoot, path));
}

function rebaseScanned(fromRoot: string, toRoot: string, path: string): string {
  const rebased = rebase(fromRoot, toRoot, path);
  invariant(rebased !== null, `${path} was scanned under ${fromRoot}`);
  return rebased;
}

function startsWithCopy(live: string, copy: string, copySize: number): boolean {
  const length = Math.min(copySize, TAIL_BYTES);
  const offset = copySize - length;
  return readAt(copy, offset, length).equals(readAt(live, offset, length));
}

function sameBytes(live: string, copy: string, size: number): boolean {
  for (let offset = 0; offset < size; offset += COMPARE_CHUNK_BYTES) {
    const length = Math.min(COMPARE_CHUNK_BYTES, size - offset);
    if (!readAt(copy, offset, length).equals(readAt(live, offset, length))) return false;
  }
  return true;
}

function appendTail(live: string, copy: string, copySize: number, liveStat: Stats): number {
  const tail = readAt(live, copySize, liveStat.size - copySize);
  appendFileSync(copy, tail);
  stampLike(copy, liveStat);
  return tail.length;
}

function archiveSession(beforeReplace: (copy: string) => void): Archiver {
  return (live, copy) => {
    const liveStat = statSync(live);
    const copyStat = statSync(copy, { throwIfNoEntry: false });
    if (!copyStat) return copyWhole(live, copy, liveStat);
    if (sameStamp(copyStat, liveStat)) return UNTOUCHED;
    if (copyStat.size === liveStat.size && sameBytes(live, copy, liveStat.size)) {
      stampLike(copy, liveStat);
      return UNTOUCHED;
    }
    if (copyStat.size < liveStat.size && startsWithCopy(live, copy, copyStat.size)) {
      return appendTail(live, copy, copyStat.size, liveStat);
    }
    return copyWhole(live, copy, liveStat, () => beforeReplace(copy));
  };
}

const archiveWhole: Archiver = (live, copy) => copyIfChanged(live, copy) ?? UNTOUCHED;

function followMoves(
  source: SessionSource,
  liveRoot: string,
  copyRoot: string,
  livePaths: readonly string[],
): void {
  const movedKey = source.movedKey;
  if (movedKey === null) return;
  const orphans = scan(copyRoot, source.sessions).filter(
    (copy) => !existsSync(rebaseScanned(copyRoot, liveRoot, copy)),
  );
  for (const live of livePaths) {
    const copy = rebaseScanned(liveRoot, copyRoot, live);
    const key = movedKey(live);
    if (key === null || existsSync(copy)) continue;
    const liveSize = statSync(live).size;
    const index = orphans.findIndex((orphan) => {
      if (movedKey(orphan) !== key) return false;
      const size = statSync(orphan).size;
      return size > 0 && size <= liveSize && startsWithCopy(live, orphan, size);
    });
    const moved = orphans[index];
    if (moved === undefined) continue;
    mkdirSync(dirname(copy), { recursive: true });
    renameSync(moved, copy);
    orphans.splice(index, 1);
  }
}

function isFileSystemError(error: unknown): error is Error & { readonly syscall: string } {
  return isEnvironmentError(error) && "syscall" in error && typeof error.syscall === "string";
}

function isReadable(path: string): boolean {
  try {
    closeSync(openSync(path, "r"));
    return true;
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    return false;
  }
}

export function archiveSources(
  env: Env,
  fail: Failure,
  beforeReplace: (copy: string) => void,
): ArchiveReport {
  let files = 0;
  let bytes = 0;

  const failArchiving = (live: string, copy: string, error: unknown): void => {
    if (!isFileSystemError(error)) throw error;
    if (isReadable(live))
      fail(copy, refuseIngest("archive_unwritable", { path: copy, detail: error.message }));
    else fail(live, refuseIngest("source_unreadable", { path: live, detail: error.message }));
  };

  const archiveOne = (live: string, copy: string, how: Archiver): void => {
    try {
      const written = how(live, copy);
      if (written > 0) {
        files += 1;
        bytes += written;
      }
    } catch (error) {
      failArchiving(live, copy, error);
    }
  };

  const archiveSessionFile = archiveSession(beforeReplace);

  for (const tool of TOOLS) {
    const source = SESSION_SOURCES[tool];
    const liveRoot = source.root(env);
    const copyRoot = archiveRootOf(tool, env);
    const copyOf = (live: string): string => rebaseScanned(liveRoot, copyRoot, live);
    const sessions = scan(liveRoot, source.sessions);
    try {
      followMoves(source, liveRoot, copyRoot, sessions);
    } catch (error) {
      failArchiving(liveRoot, copyRoot, error);
    }
    for (const live of sessions) {
      archiveOne(live, copyOf(live), archiveSessionFile);
      for (const sidecar of source.sidecars(live)) {
        if (existsSync(sidecar)) archiveOne(sidecar, copyOf(sidecar), archiveWhole);
      }
    }
    if (source.titles !== null) {
      const titles = join(liveRoot, source.titles.file);
      if (existsSync(titles)) archiveOne(titles, copyOf(titles), archiveWhole);
    }
  }

  return { files, bytes };
}
