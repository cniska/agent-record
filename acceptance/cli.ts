import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { SyncSubprocess } from "bun";
import { z } from "zod";

const CLI = join(import.meta.dir, "cli-no-wait.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
const SCRATCH_OUTSIDE_TEMP = join(import.meta.dir, ".scratch");
const BUN_CACHE_OUTSIDE_HOMES = join(tmpdir(), "agent-record-acceptance-bun-cache");
const CWD_PLACEHOLDER = "{{cwd}}";
const BUILD_RELEASE = join(import.meta.dir, "..", "scripts", "build-compiled.sh");
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const LAUNCHER = join(import.meta.dir, "..", "scripts", "launcher.sh");
const PLUGIN_HOOKS = join(import.meta.dir, "..", "plugin", "hooks");
const RELEASE_DOWNLOADS = "https://github.com/cniska/agent-record/releases/latest/download";

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

export type Home = {
  readonly root: string;
  readonly record: string;
  readonly archive: string;
  readonly state: string;
  readonly bin: string;
  readonly mirror: string;
};

type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

function ranOf(ran: SyncSubprocess<"pipe", "pipe">): Ran {
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

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
  return {
    root,
    record: join(data, "sessions.db"),
    archive: join(data, "archive"),
    state: join(root, "state", "agent-record"),
    bin: join(root, "bin"),
    mirror: join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "agent-record"),
  };
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
  for (const commit of commits) commitTo(repo, commit);
  return repo;
}

export function scratchWorktree(repo: string, worktree: string, commit: Commit): string {
  git(repo, ["worktree", "add", "--quiet", "-b", "side", worktree]);
  commitTo(worktree, commit);
  return worktree;
}

export function commitTo(checkout: string, { subject, file, at }: Commit): void {
  mkdirSync(dirname(join(checkout, file)), { recursive: true });
  writeFileSync(join(checkout, file), `${subject}\n`);
  git(checkout, ["add", file]);
  git(checkout, ["commit", "--quiet", "-m", subject], at);
}

export function sync(home: Home, env: RunEnv = {}): SyncCommandResult {
  return succeeded(runCli(home, ["sync"], env), "sync", SYNC_COMMAND_RESULT);
}

export function rebuild(home: Home): RebuildResult {
  return succeeded(runCli(home, ["rebuild"]), "rebuild", REBUILD_RESULT);
}

export function withLaunchctl(home: Home, agentLoaded: boolean): Home {
  const launchctl = join(home.bin, "launchctl");
  mkdirSync(home.bin, { recursive: true });
  writeFileSync(launchctl, `#!/bin/sh\nexit ${agentLoaded ? 0 : 1}\n`);
  chmodSync(launchctl, 0o755);
  return home;
}

export function syncedHome(home: Home = scratchHome()): Home {
  sync(home);
  return home;
}

type RunEnv = Readonly<Record<string, string>>;

export function withICloudDrive(home: Home): Home {
  mkdirSync(dirname(home.mirror), { recursive: true });
  return home;
}

function homeEnv(home: Home): RunEnv {
  return {
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_CACHE_OUTSIDE_HOMES,
    HOME: home.root,
    XDG_DATA_HOME: join(home.root, "data"),
    XDG_STATE_HOME: join(home.root, "state"),
  };
}

function cliEnv(home: Home, env: RunEnv): RunEnv {
  return { PATH: `${home.bin}:${process.env.PATH}`, ...homeEnv(home), ...env };
}

export function runCli(home: Home, args: readonly string[], env: RunEnv = {}): Ran {
  return ranOf(Bun.spawnSync([process.execPath, CLI, ...args], { env: cliEnv(home, env) }));
}

const NETWORK_DENIED = "(version 1)(allow default)(deny network*)";

export function runCliOffline(home: Home, args: readonly string[]): Ran {
  return ranOf(
    Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", NETWORK_DENIED, process.execPath, CLI, ...args], {
      env: cliEnv(home, {}),
    }),
  );
}

const EXIT_STATUS = z.coerce.number().int().nonnegative();

export function cliOnPathExit(home: Home): Promise<number> {
  const exited = join(home.root, "cli-exited");
  expect(Bun.spawnSync(["mkfifo", exited]).exitCode).toBe(0);
  mkdirSync(home.bin, { recursive: true });
  const cli = join(home.bin, "agent-record");
  writeFileSync(cli, `#!/bin/sh\n"${process.execPath}" "${CLI}" "$@"\necho "$?" > "${exited}"\n`);
  chmodSync(cli, 0o755);
  const reader = Bun.spawn(["cat", exited], { stdout: "pipe" });
  return new Response(reader.stdout).text().then((status) => EXIT_STATUS.parse(status.trim()));
}

export function pluginNote(): string {
  return readFileSync(join(PLUGIN_HOOKS, "note.md"), "utf8");
}

export function runPluginHook(home: Home): Ran {
  const ran = Bun.spawnSync(["/bin/sh", join(PLUGIN_HOOKS, "session-start.sh")], {
    env: { PATH: `${home.bin}:${SYSTEM_PATH}`, ...homeEnv(home) },
  });
  return ranOf(ran);
}

export function compiledRelease(dir: string, version?: string, releasesUrl?: string): string {
  const binary = join(dir, "agent-record");
  const versionArgs =
    version === undefined ? [] : [version, ...(releasesUrl === undefined ? [] : [releasesUrl])];
  const ran = Bun.spawnSync(["/bin/bash", BUILD_RELEASE, binary, ...versionArgs], {
    env: { PATH: `${dirname(process.execPath)}:${SYSTEM_PATH}` },
  });
  expect({ exitCode: ran.exitCode, stderr: ran.stderr.toString() }).toMatchObject({ exitCode: 0 });
  return binary;
}

export function installedLauncher(bin: string, baseline: string, version: string): string {
  const launcher = join(bin, "agent-record");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    launcher,
    readFileSync(LAUNCHER, "utf8")
      .replace("__BASELINE_BIN__", baseline)
      .replace("__BASELINE_VERSION__", version),
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

export function releaseAssets(dir: string, binary: string, target: string): string {
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, `agent-record-${target}.tar.gz`);
  const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", dirname(binary), "agent-record"]);
  expect(packed.exitCode).toBe(0);
  writeFileSync(join(dir, "launcher.sh"), readFileSync(LAUNCHER));
  writeChecksum(tarball, join(dir, `agent-record-${target}.sha256`));
  writeChecksum(join(dir, "launcher.sh"), join(dir, "launcher.sha256"));
  return dir;
}

function writeChecksum(file: string, to: string): void {
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(to, `${digest}  ${relative(dirname(file), file)}\n`);
}

export function curlServing(bin: string, assets: string): string {
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    [
      "#!/bin/sh",
      "url=; out=",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done',
      `file="${assets}/\${url##*/}"`,
      `case "$url" in ${RELEASE_DOWNLOADS}/*) ;; *) exit 22 ;; esac`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
      "",
    ].join("\n"),
  );
  chmodSync(curl, 0o755);
  return bin;
}

export function runOnCleanMachine(
  home: Home,
  bins: readonly string[],
  args: readonly string[],
  env: RunEnv = {},
): Ran {
  const ran = Bun.spawnSync([...args], {
    env: { PATH: [...bins, SYSTEM_PATH].join(":"), HOME: home.root, AGENT_RECORD_SKIP_UPDATE: "1", ...env },
  });
  return ranOf(ran);
}

function releaseEnv(home: Home): RunEnv {
  return { XDG_DATA_HOME: join(home.root, "data"), XDG_STATE_HOME: join(home.root, "state") };
}

export async function runReleased(
  home: Home,
  bins: readonly string[],
  args: readonly string[],
  env: RunEnv = {},
): Promise<Ran> {
  const child = Bun.spawn([...args], {
    env: { PATH: [...bins, SYSTEM_PATH].join(":"), HOME: home.root, ...releaseEnv(home), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export type ReleaseServer = { readonly url: string; readonly requests: readonly string[]; stop(): void };

export function releaseServer(assets: string, tag: string): ReleaseServer {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname, origin } = new URL(request.url);
      requests.push(pathname);
      if (pathname === "/releases/latest") {
        return Response.json({
          tag_name: tag,
          assets: readdirSync(assets).map((name) => ({
            name,
            browser_download_url: `${origin}/download/${name}`,
          })),
        });
      }
      const file = Bun.file(join(assets, pathname.replace(/^\/download\//, "")));
      return pathname.startsWith("/download/") ? new Response(file) : new Response(null, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/releases/latest`,
    requests,
    stop: () => server.stop(true),
  };
}

const UPDATE_SETTLED_WITHIN_MS = 30_000;
const UPDATE_POLL_MS = 50;

function updateStampPath(home: Home): string {
  return join(home.state, "last-update-check");
}

export function withUpdateCheckedAt(home: Home, at: string): Home {
  mkdirSync(home.state, { recursive: true });
  writeFileSync(updateStampPath(home), `${JSON.stringify({ kind: "current", at, latest: "0.1.0" })}\n`);
  return home;
}

export function withUpdateCheckBegunAt(home: Home, at: string): Home {
  mkdirSync(home.state, { recursive: true });
  writeFileSync(updateStampPath(home), `${JSON.stringify({ kind: "checking", at })}\n`);
  return home;
}

const UPDATE_STAMP = z.looseObject({ kind: z.string(), at: z.string() });

type UpdateStamp = z.infer<typeof UPDATE_STAMP>;

function updateStamp(home: Home): UpdateStamp | null {
  const path = updateStampPath(home);
  if (!existsSync(path)) return null;
  return UPDATE_STAMP.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function settledUpdateCheck(home: Home, plantedAt: string | null = null): Promise<string> {
  const deadline = Date.now() + UPDATE_SETTLED_WITHIN_MS;
  while (Date.now() < deadline) {
    const stamp = updateStamp(home);
    const locked = existsSync(join(home.state, "locks", "update"));
    if (stamp !== null && stamp.kind !== "checking" && stamp.at !== plantedAt && !locked) return stamp.kind;
    await Bun.sleep(UPDATE_POLL_MS);
  }
  throw new Error(`no update check settled in ${home.state} within ${UPDATE_SETTLED_WITHIN_MS} ms`);
}

export async function updateStampAfter(home: Home, ms: number): Promise<UpdateStamp | null> {
  await Bun.sleep(ms);
  return updateStamp(home);
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
  eventLogs: COUNT,
  filesRead: COUNT,
  orphanSubagents: z.array(z.string()),
  unlinkedSubagents: COUNT,
  failures: z.array(z.strictObject({ path: z.string(), error: ERROR })),
  dropped: z.array(z.strictObject({ path: z.string(), lines: z.array(COUNT) })),
  git: z.strictObject({ repos: COUNT, commits: COUNT, files: COUNT, unchanged: COUNT }),
  repoFiles: z.strictObject({ repos: COUNT, files: COUNT, unchanged: COUNT }),
});

const REBUILD_RESULT = SYNC_RESULT.extend({ backup: z.string(), unreadCheckouts: z.array(z.string()) });

type RebuildResult = z.infer<typeof REBUILD_RESULT>;

export const SYNC_COMMAND_RESULT = SYNC_RESULT.extend({
  mirror: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("mirrored"), path: z.string(), files: COUNT, bytes: COUNT }),
    z.strictObject({ state: z.literal("unreachable"), path: z.string(), detail: z.string() }),
  ]),
  rebuilt: z
    .strictObject({ from: COUNT, to: COUNT, backup: z.string(), unreadCheckouts: z.array(z.string()) })
    .nullable(),
});

type SyncCommandResult = z.infer<typeof SYNC_COMMAND_RESULT>;

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

type DoctorReport = z.infer<typeof DOCTOR_RESULT>;

export function doctor(home: Home): { readonly exitCode: number; readonly report: DoctorReport } {
  const ran = runCli(home, ["doctor"]);
  expect(ran.stderr).toBe("");
  return { exitCode: ran.exitCode, report: okLine(ran, "doctor", DOCTOR_RESULT) };
}

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

function errorLine(ran: Ran, command: string, kind: CliError["kind"]): CliError {
  expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({ exitCode: 1, stdout: "" });
  expect(ran.stderr).toMatch(ONE_LINE);
  const { error } = z
    .strictObject({ command: z.literal(command), ok: z.literal(false), error: ERROR })
    .parse(JSON.parse(ran.stderr));
  expect(error.kind).toBe(kind);
  return error;
}

export function refused(ran: Ran, command: string): CliError {
  return errorLine(ran, command, "refusal");
}

export function faulted(ran: Ran, command: string): CliError {
  return errorLine(ran, command, "fault");
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

export function withSyncFinishedAt(home: Home, at: string): Home {
  mkdirSync(home.state, { recursive: true });
  writeFileSync(
    join(home.state, "last-sync"),
    `${JSON.stringify({ kind: "finished", at, failures: null })}\n`,
  );
  return home;
}

export function withMirroredAt(home: Home, at: string): Home {
  mkdirSync(home.mirror, { recursive: true });
  writeFileSync(join(home.mirror, "last-mirror"), `${JSON.stringify({ at })}\n`);
  return home;
}

export function lockHeldBy(home: Home, pid: number): string {
  const lock = join(home.state, "locks", "record");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), String(pid));
  return lock;
}

export function holdingRecord<T>(home: Home, hold: "write" | "exclusive", run: () => T): T {
  using db = new Database(home.record);
  if (hold === "exclusive") db.run("PRAGMA locking_mode = EXCLUSIVE");
  db.run("BEGIN IMMEDIATE");
  try {
    return run();
  } finally {
    db.run("ROLLBACK");
  }
}

export function setSchemaVersion(home: Home, version: number): void {
  using db = new Database(home.record);
  db.run(`PRAGMA user_version = ${version}`);
}

export type PlantedInsertFailure = { readonly table: string; readonly when: string };

export function failingRecordWrites<T>(home: Home, insert: PlantedInsertFailure, run: () => T): T {
  using db = new Database(home.record);
  db.run(
    `CREATE TRIGGER planted_write_failure BEFORE INSERT ON ${insert.table} WHEN ${insert.when}
     BEGIN SELECT RAISE(ABORT, 'planted write failure'); END`,
  );
  try {
    return run();
  } finally {
    db.run("DROP TRIGGER planted_write_failure");
  }
}
