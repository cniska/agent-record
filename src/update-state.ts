import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Env } from "./env";
import { parseJson } from "./ingest-source-read";
import { stagedBuildPath, stagedBuildsDir, updateRejectedPath, updateStampPath } from "./paths";
import { DAY_MS, StampAt } from "./timestamp";
import { refuseUpdate } from "./update-contract";
import { compareVersions, isNewer, parseVersion } from "./update-version";

const UpdateCheck = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("checking"), at: StampAt }),
  z.strictObject({ kind: z.literal("current"), at: StampAt, latest: z.string() }),
  z.strictObject({ kind: z.literal("staged"), at: StampAt, latest: z.string() }),
  z.strictObject({ kind: z.literal("failed"), at: StampAt, detail: z.string() }),
]);
export type UpdateCheck = z.infer<typeof UpdateCheck>;

export type UpdateStamp =
  | { readonly kind: "never" }
  | { readonly kind: "unreadable"; readonly path: string }
  | UpdateCheck;

const UPDATE_CHECK_INTERVAL_MS = DAY_MS;

export function checkIsDue(stamp: UpdateStamp, now: Date): boolean {
  if (stamp.kind === "never" || stamp.kind === "unreadable") return true;
  return now.getTime() - stamp.at.getTime() > UPDATE_CHECK_INTERVAL_MS;
}

const Rejected = z.array(z.string());

export type StagedBuild = { readonly version: string; readonly dir: string };

export function isWanted(version: string, running: string, rejected: readonly string[]): boolean {
  return isNewer(version, running) && !rejected.includes(version);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readUpdateStamp(env: Env): UpdateStamp {
  const path = updateStampPath(env);
  if (!existsSync(path)) return { kind: "never" };
  const read = parseJson(readFileSync(path, "utf8"), UpdateCheck);
  if (read.kind === "invalid") return { kind: "unreadable", path };
  return read.value;
}

export function writeUpdateStamp(check: UpdateCheck, env: Env): void {
  writeJson(updateStampPath(env), check);
}

export function readRejected(env: Env): readonly string[] {
  const path = updateRejectedPath(env);
  if (!existsSync(path)) return [];
  const read = parseJson(readFileSync(path, "utf8"), Rejected);
  if (read.kind === "invalid") throw refuseUpdate("rejected_unreadable", { path, detail: read.detail });
  return read.value;
}

export function writeRejected(versions: readonly string[], env: Env): void {
  writeJson(updateRejectedPath(env), versions);
}

function isExecutable(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat?.isFile() === true && (stat.mode & 0o111) !== 0;
}

export function stagedBuilds(env: Env): readonly StagedBuild[] {
  const root = stagedBuildsDir(env);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((name) => {
      const version = parseVersion(name);
      return version !== null && isExecutable(stagedBuildPath(env, name))
        ? [{ version, build: { version: name, dir: join(root, name) } }]
        : [];
    })
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ build }) => build);
}
