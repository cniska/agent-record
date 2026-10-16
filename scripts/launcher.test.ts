import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { refused, SYSTEM_PATH } from "../acceptance/cli";
import { launcher, PLATFORMS } from "./build-npm";

const SCOPE = "@cniska";

const NAME = "agent-record";

const TARGET = `${process.platform}-${process.arch}`;

const STUB = [
  "#!/bin/sh",
  `printf 'self %s\\n' "$$"`,
  `for arg; do printf 'arg %s\\n' "$arg"; done`,
  `printf 'stdin %s\\n' "$(cat)"`,
  "exit 7",
  "",
].join("\n");

const COMMAND_STUB = ["#!/bin/sh", `printf 'command %s\\n' "$AGENT_RECORD_COMMAND"`, ""].join("\n");

const UNSUPPORTED_UNAME = ["#!/bin/sh", 'case "$1" in -s) echo Plan9 ;; -m) echo mips ;; esac', ""].join(
  "\n",
);

type Layout = "nested" | "hoisted";

type Ran = {
  readonly pid: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-record-launcher-")));
  scratch.push(dir);
  return dir;
}

function executable(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function prefix(
  layout: Layout,
  platformTarget: string | null,
  build = STUB,
): { readonly bin: string; readonly stub: string } {
  const root = scratchDir();
  const modules = join(root, "node_modules", SCOPE);
  const shim = join(modules, NAME);
  executable(join(shim, "bin", NAME), launcher(PLATFORMS));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(relative(bin, join(shim, "bin", NAME)), join(bin, NAME));
  const platformDir =
    layout === "nested"
      ? join(shim, "node_modules", SCOPE, `${NAME}-${platformTarget ?? TARGET}`)
      : join(modules, `${NAME}-${platformTarget ?? TARGET}`);
  const stub = join(platformDir, NAME);
  if (platformTarget !== null) executable(stub, build);
  return { bin, stub };
}

async function run(
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  input = "",
  command = NAME,
): Promise<Ran> {
  const child = Bun.spawn([command, ...args], {
    cwd: bin,
    env: { PATH: `${bin}:${SYSTEM_PATH}`, ...env },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { pid: child.pid, exitCode, stdout, stderr };
}

describe.each<Layout>(["nested", "hoisted"])("the launcher over the %s layout", (layout) => {
  test("becomes the platform binary, with its arguments, stdin and exit code, leaving no shell as its parent", async () => {
    const { bin } = prefix(layout, TARGET);
    const ran = await run(bin, ["install", "format --command", "two  spaces"], {}, "in\n");
    expect(ran).toMatchObject({
      exitCode: 7,
      stdout: `self ${ran.pid}\narg install\narg format --command\narg two  spaces\nstdin in\n`,
      stderr: "",
    });
  });

  test("hands the platform binary the symlinked bin's path as its command, absolute and unresolved", async () => {
    const { bin } = prefix(layout, TARGET, COMMAND_STUB);
    const command = `command ${join(bin, NAME)}\n`;
    expect(await run(bin, [])).toMatchObject({ exitCode: 0, stdout: command, stderr: "" });
    expect(await run(bin, [], {}, "", `./${NAME}`)).toMatchObject({
      exitCode: 0,
      stdout: command,
      stderr: "",
    });
  });

  test("refuses a platform with no build, naming the builds", async () => {
    const { bin } = prefix(layout, TARGET);
    const fakeBin = scratchDir();
    executable(join(fakeBin, "uname"), UNSUPPORTED_UNAME);
    const ran = await run(bin, ["--version"], { PATH: `${fakeBin}:${bin}:${SYSTEM_PATH}` });
    expect(refused(ran, NAME)).toEqual({
      kind: "refusal",
      code: "no_build_for_platform",
      message: "agent-record ships no build for Plan9-mips, only darwin-arm64 and linux-x64",
      meta: {},
      resolve: "build agent-record from source with Bun, as its README says",
    });
  });

  test("refuses when the platform package is installed nowhere", async () => {
    const { bin } = prefix(layout, null);
    expect(refused(await run(bin, ["--version"]), NAME)).toEqual({
      kind: "refusal",
      code: "platform_package_missing",
      message: `@cniska/agent-record-${TARGET} is not installed beside @cniska/agent-record`,
      meta: {},
      resolve: "reinstall @cniska/agent-record with optional dependencies enabled",
    });
  });

  test("refuses a platform binary that is not executable", async () => {
    const { bin, stub } = prefix(layout, TARGET);
    chmodSync(stub, 0o644);
    expect(refused(await run(bin, ["--version"]), NAME)).toMatchObject({
      kind: "refusal",
      code: "binary_failed",
      resolve: "reinstall @cniska/agent-record",
    });
  });
});
