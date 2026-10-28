import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";

export type Release = { readonly tag: string; readonly schema: number };

export type Candidate = Release & { readonly version: string };

const SCHEMA_LINE = /^export const SCHEMA_VERSION = (\d+);$/m;
const SCHEMA_FILE = "src/db-schema.ts";
const TAG_PREFIX = "v";

type Version = { readonly major: number; readonly minor: number; readonly patch: number };

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(text: string): Version | null {
  const [, major, minor, patch] = VERSION.exec(text) ?? [];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function schemaOf(source: string): number {
  const [, schema] = SCHEMA_LINE.exec(source) ?? [];
  if (schema === undefined) throw new Error(`${SCHEMA_FILE} declares no SCHEMA_VERSION`);
  return Number(schema);
}

export function releaseProblems(candidate: Candidate, previous: Release | null): readonly string[] {
  const next = parseVersion(candidate.version);
  if (next === null) return [`package.json's version ${candidate.version} is not of the form x.y.z`];
  const problems: string[] = [];
  if (candidate.tag !== `${TAG_PREFIX}${candidate.version}`)
    problems.push(`the tag ${candidate.tag} does not name package.json's version ${candidate.version}`);
  if (previous === null) return problems;
  const before = parseVersion(previous.tag.slice(TAG_PREFIX.length));
  if (before === null) return [...problems, `the previous tag ${previous.tag} names no x.y.z version`];
  if (compareVersions(next, before) <= 0)
    problems.push(`${candidate.version} is not newer than the previous release ${previous.tag}`);
  const patchOnly = next.major === before.major && next.minor === before.minor;
  if (candidate.schema !== previous.schema && patchOnly)
    problems.push(
      `the schema version changed from ${previous.schema} to ${candidate.schema} since ${previous.tag}, so this is a minor or major release, not a patch`,
    );
  return problems;
}

function git(args: readonly string[]): { readonly ok: boolean; readonly out: string } {
  const ran = spawnSync("git", args, { encoding: "utf8" });
  return { ok: ran.status === 0, out: ran.stdout.trim() };
}

function previousRelease(tag: string): Release | null {
  const tagged = git(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]).ok;
  const before = tagged ? `${tag}^` : "HEAD";
  const described = git(["describe", "--tags", "--abbrev=0", "--match", `${TAG_PREFIX}*`, before]);
  if (!described.ok) return null;
  const source = git(["show", `${described.out}:${SCHEMA_FILE}`]);
  if (!source.ok) throw new Error(`${described.out} holds no ${SCHEMA_FILE}`);
  return { tag: described.out, schema: schemaOf(source.out) };
}

if (import.meta.main) {
  const [tag] = process.argv.slice(2);
  if (tag === undefined) {
    process.stderr.write("usage: bun scripts/release-check.ts <tag>\n");
    process.exit(2);
  }
  const root = join(import.meta.dir, "..");
  const candidate = { tag, version, schema: schemaOf(readFileSync(join(root, SCHEMA_FILE), "utf8")) };
  const problems = releaseProblems(candidate, previousRelease(tag));
  for (const problem of problems) process.stderr.write(`release-check: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  console.log(`${tag} is a release of ${version} at schema version ${candidate.schema}`);
}
