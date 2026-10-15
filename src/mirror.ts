import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { type CodedError, errorRecord, type PathFailure, refuser } from "./coded-error";
import type { Env } from "./env";
import { errorCode, isEnvironmentError } from "./error-read";
import { copyBackup } from "./file-backup";
import { copyIfChanged, PART_SUFFIX } from "./file-copy";
import { parseJson } from "./ingest-source-read";
import { archiveDir, mirrorArchiveDir, mirrorStampPath } from "./paths";
import { StampAt } from "./timestamp";

type MirrorReport =
  | { readonly state: "mirrored"; readonly path: string; readonly files: number; readonly bytes: number }
  | { readonly state: "unreachable"; readonly path: string; readonly detail: string };

export type MirrorPass = {
  readonly report: MirrorReport;
  readonly failures: readonly PathFailure[];
};

export type MirrorState =
  | { readonly kind: "unreachable"; readonly path: string; readonly detail: string }
  | { readonly kind: "never"; readonly path: string }
  | { readonly kind: "unreadable"; readonly path: string; readonly stamp: string }
  | { readonly kind: "mirrored"; readonly path: string; readonly at: Date };

const MirrorStamp = z.strictObject({ at: StampAt });

const refuseMirror = refuser<{
  readonly mirror_unwritable: { readonly path: string; readonly detail: string };
  readonly mirror_stamp_unwritable: { readonly path: string; readonly detail: string };
}>({
  mirror_unwritable: {
    message: ({ path, detail }) => `cannot write the mirror copy ${path}: ${detail}`,
    resolve: ({ path }) =>
      `free space in or fix the permissions of ${dirname(path)}, then run agent-record sync; until then the mirror keeps the copy made before`,
  },
  mirror_stamp_unwritable: {
    message: ({ path, detail }) => `mirrored the whole archive but cannot record when in ${path}: ${detail}`,
    resolve: ({ path }) =>
      `free space in or fix the permissions of ${dirname(path)}, then run agent-record sync; until then doctor reads the time recorded before`,
  },
});

function setAsideCopyIfItShrinks(archived: Stats, copy: Stats, path: string): void {
  if (archived.size < copy.size) copyBackup(path);
}

function archiveFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(PART_SUFFIX))
    .map((entry) => join(entry.parentPath, entry.name));
}

function unreachableDetail(env: Env): string | null {
  const parent = dirname(env.mirrorDir);
  try {
    if (statSync(parent).isDirectory()) return null;
    return `${parent} is not a folder`;
  } catch (error) {
    if (!isEnvironmentError(error)) throw error;
    if (errorCode(error) === "ENOENT") return `there is no folder at ${parent}`;
    return `cannot reach ${parent}: ${error.message}`;
  }
}

export function mirrorArchive(env: Env, now: Date): MirrorPass {
  const path = env.mirrorDir;
  const detail = unreachableDetail(env);
  if (detail !== null) return { report: { state: "unreachable", path, detail }, failures: [] };

  const failures: PathFailure[] = [];
  const attempt = (target: string, refusal: (detail: string) => CodedError, write: () => void): void => {
    try {
      write();
    } catch (error) {
      if (!isEnvironmentError(error)) throw error;
      failures.push({ path: target, error: errorRecord(refusal(error.message)) });
    }
  };

  const archive = archiveDir(env);
  let files = 0;
  let bytes = 0;
  for (const from of archiveFiles(archive)) {
    const to = join(mirrorArchiveDir(env), relative(archive, from));
    const unwritable = (detail: string) => refuseMirror("mirror_unwritable", { path: to, detail });
    attempt(to, unwritable, () => {
      const copied = copyIfChanged(from, to, "modified", setAsideCopyIfItShrinks);
      if (copied === null) return;
      files += 1;
      bytes += copied;
    });
  }
  if (failures.length === 0) {
    const stamp = mirrorStampPath(env);
    const unwritable = (detail: string) => refuseMirror("mirror_stamp_unwritable", { path: stamp, detail });
    attempt(stamp, unwritable, () => {
      mkdirSync(dirname(stamp), { recursive: true });
      writeFileSync(stamp, `${JSON.stringify({ at: now })}\n`);
    });
  }
  return { report: { state: "mirrored", path, files, bytes }, failures };
}

export function readMirror(env: Env): MirrorState {
  const path = env.mirrorDir;
  const detail = unreachableDetail(env);
  if (detail !== null) return { kind: "unreachable", path, detail };
  const stamp = mirrorStampPath(env);
  if (!existsSync(stamp)) return { kind: "never", path };
  const read = parseJson(readFileSync(stamp, "utf8"), MirrorStamp);
  if (read.kind === "invalid") return { kind: "unreadable", path, stamp };
  return { kind: "mirrored", path, at: read.value.at };
}
