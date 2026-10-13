import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
const SCRATCH_OUTSIDE_TEMP = join(import.meta.dir, ".scratch");
const BUN_CACHE_OUTSIDE_HOMES = join(tmpdir(), "agent-record-acceptance-bun-cache");
const CWD_PLACEHOLDER = "{{cwd}}";

const TOOL = z.enum(["claude", "codex", "grok", "pi", "omp"]);

type Tool = z.infer<typeof TOOL>;

const TOOL_ROOTS: Readonly<Record<Tool, readonly string[]>> = {
  claude: [".claude", "projects"],
  codex: [".codex"],
  grok: [".grok", "sessions"],
  pi: [".pi", "agent", "sessions"],
  omp: [".omp", "agent", "sessions"],
};

export type Fixture = `${Tool}/${string}`;

export type Home = { readonly root: string; readonly record: string; readonly archive: string };

type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

const scratchDirs: string[] = [];

function scratchDirUnder(parent: string): string {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "scratch-"));
  scratchDirs.push(dir);
  return dir;
}

export function scratchTempDir(): string {
  return scratchDirUnder(join(tmpdir(), "agent-record-acceptance"));
}

export function scratchDirOutsideTemp(): string {
  return scratchDirUnder(SCRATCH_OUTSIDE_TEMP);
}

export function scratchHome(): Home {
  const root = scratchTempDir();
  const data = join(root, "data", "agent-record");
  return { root, record: join(data, "sessions.db"), archive: join(data, "archive") };
}

export function removeScratch(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function splitFixture(fixture: Fixture): { tool: Tool; rest: string } {
  const [tool, ...rest] = fixture.split("/");
  return { tool: TOOL.parse(tool), rest: join(...rest) };
}

export function livePath(home: Home, fixture: Fixture): string {
  const { tool, rest } = splitFixture(fixture);
  return join(home.root, ...TOOL_ROOTS[tool], rest);
}

export function archivedPath(home: Home, fixture: Fixture): string {
  const { tool, rest } = splitFixture(fixture);
  return join(home.archive, tool, rest);
}

export function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

export function withFixtures(home: Home, fixtures: readonly Fixture[], cwd?: string): Home {
  for (const fixture of fixtures) {
    const source = join(FIXTURES, fixture);
    const target = livePath(home, fixture);
    const files = statSync(source).isDirectory() ? filesUnder(source) : [""];
    for (const file of files) {
      const text = readFileSync(join(source, file), "utf8");
      if (text.includes(CWD_PLACEHOLDER) && cwd === undefined) throw new Error(`${fixture} needs a cwd`);
      const copy = join(target, file);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, cwd === undefined ? text : text.replaceAll(CWD_PLACEHOLDER, cwd));
    }
  }
  return home;
}

type Commit = { readonly subject: string; readonly file: string; readonly at: string };

function git(repo: string, args: readonly string[], at?: string): void {
  const ran = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.test",
      ...(at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
    },
  });
  expect({ args, exitCode: ran.exitCode, stderr: ran.stderr.toString() }).toMatchObject({ exitCode: 0 });
}

export function scratchRepo(repo: string, origin: string, commits: readonly Commit[]): string {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["remote", "add", "origin", origin]);
  for (const { subject, file, at } of commits) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), `${subject}\n`);
    git(repo, ["add", file]);
    git(repo, ["commit", "--quiet", "-m", subject], at);
  }
  return repo;
}

export function sync(home: Home): SyncResult {
  return succeeded(runCli(home, ["sync"]), "sync", SYNC_RESULT);
}

export function rebuild(home: Home): SyncResult {
  return succeeded(runCli(home, ["rebuild"]), "rebuild", SYNC_RESULT);
}

export function syncedHome(home: Home = scratchHome()): Home {
  sync(home);
  return home;
}

export function runCli(home: Home, args: readonly string[]): Ran {
  const ran = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      PATH: process.env.PATH,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_CACHE_OUTSIDE_HOMES,
      HOME: home.root,
      XDG_DATA_HOME: join(home.root, "data"),
      XDG_STATE_HOME: join(home.root, "state"),
    },
  });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

const ERROR = z.strictObject({
  kind: z.enum(["refusal", "fault"]),
  code: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()),
  resolve: z.string(),
});

type CliError = z.infer<typeof ERROR>;

const COUNT = z.number().int().nonnegative();

const SYNC_RESULT = z.strictObject({
  archive: z.strictObject({ files: COUNT, bytes: COUNT }),
  sources: z.array(z.strictObject({ tool: TOOL, files: COUNT })),
  filesRead: COUNT,
  orphanSubagents: z.array(z.string()),
  failures: z.array(z.strictObject({ path: z.string(), error: ERROR })),
  dropped: z.array(z.strictObject({ path: z.string(), lines: z.array(COUNT) })),
  git: z.strictObject({ repos: COUNT, commits: COUNT, files: COUNT, unchanged: COUNT }),
  repoFiles: z.strictObject({ repos: COUNT, files: COUNT, unchanged: COUNT }),
});

type SyncResult = z.infer<typeof SYNC_RESULT>;

export const QUERY_RESULT = z.strictObject({
  denominator: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  note: z.string().nullable(),
  more: z.string().nullable(),
});

type QueryResult = z.infer<typeof QUERY_RESULT>;

export const DOCTOR_RESULT = z.strictObject({
  checks: z.array(
    z.strictObject({
      name: z.string(),
      state: z.enum(["ok", "warn", "fail"]),
      detail: z.string(),
      fix: z.string().nullable(),
    }),
  ),
  failing: z.number(),
});

export const USAGE_ENTRY = z.strictObject({ name: z.string(), usage: z.string(), summary: z.string() });

const ONE_LINE = /^[^\n]+\n$/;

export function succeeded<T extends z.ZodType>(ran: Ran, command: string, result: T): z.infer<T> {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({ exitCode: 0, stderr: "" });
  return okLine(ran, command, result);
}

export function okLine<T extends z.ZodType>(ran: Ran, command: string, result: T): z.infer<T> {
  expect(ran.stdout).toMatch(ONE_LINE);
  const line = z
    .strictObject({ command: z.literal(command), ok: z.literal(true), result: z.unknown() })
    .parse(JSON.parse(ran.stdout));
  return result.parse(line.result);
}

export function refused(ran: Ran, command: string): CliError {
  expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({ exitCode: 1, stdout: "" });
  expect(ran.stderr).toMatch(ONE_LINE);
  return z
    .strictObject({ command: z.literal(command), ok: z.literal(false), error: ERROR })
    .parse(JSON.parse(ran.stderr)).error;
}

const EVERY_ROW = "1000000";

export function rowsOf(home: Home, select: string): QueryResult["rows"] {
  const result = succeeded(runCli(home, ["sql", select, "--rows", EVERY_ROW]), "sql", QUERY_RESULT);
  expect(result.more).toBeNull();
  return result.rows;
}

export function schemaVersion(home: Home): number {
  using db = new Database(home.record, { readonly: true });
  return z.strictObject({ user_version: z.number() }).parse(db.query("PRAGMA user_version").get())
    .user_version;
}

export function setSchemaVersion(home: Home, version: number): void {
  using db = new Database(home.record);
  db.run(`PRAGMA user_version = ${version}`);
}
