import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlServing, releaseAssets, SYSTEM_PATH } from "../acceptance/cli";

const INSTALL = join(import.meta.dir, "install.sh");
const TARGET = `${process.platform}-${process.arch}`;

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-record-install-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function executable(path: string, lines: readonly string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

function release(dir: string, version: string): string {
  const build = mkdtempSync(join(dir, "build-"));
  executable(join(build, "agent-record"), ["#!/bin/sh", `printf '%s\\n' '${version}'`]);
  return releaseAssets(mkdtempSync(join(dir, "release-")), join(build, "agent-record"), TARGET);
}

function cuttingWritesInto(bin: string, cut: string): void {
  for (const tool of ["mv", "cp"])
    executable(join(bin, tool), [
      "#!/bin/sh",
      'for arg in "$@"; do case "$arg" in -*) ;; *) set -- "$@" "$arg" ;; esac; shift; done',
      'src="$1"; dest="$2"',
      `case "$dest" in "${cut}"/*) ;; *) exec /bin/${tool} "$src" "$dest" ;; esac`,
      `[ "$(dirname "$src")" = "$(dirname "$dest")" ] && exec /bin/${tool} "$src" "$dest"`,
      'head -c 16 "$src" >"$dest"',
      "exit 1",
    ]);
}

function install(home: string, path: readonly string[]): { exitCode: number; stderr: string } {
  const ran = Bun.spawnSync(["/bin/sh", INSTALL], {
    env: { HOME: home, PATH: [...path, SYSTEM_PATH].join(":"), SHELL: "/bin/zsh" },
  });
  return { exitCode: ran.exitCode, stderr: ran.stderr.toString() };
}

function versionOf(binary: string): string {
  return Bun.spawnSync([binary, "--version"]).stdout.toString();
}

describe("install.sh", () => {
  test("adds the install directory to PATH when only a directory its name matches as a pattern is there", () => {
    const dir = scratchDir();
    const home = join(dir, "a.b");
    const bin = join(dir, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    writeFileSync(join(home, ".zshrc"), "");
    curlServing(bin, release(dir, "0.1.0"));
    expect(install(home, [bin, join(dir, "aXb", ".local", "bin")]).exitCode).toBe(0);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(`\nexport PATH="${home}/.local/bin:$PATH"\n`);
  });

  for (const cut of [join(".local", "lib"), join(".local", "bin")])
    test(`leaves the previous install whole when a write into ${cut} is cut off`, () => {
      const dir = scratchDir();
      const home = join(dir, "home");
      const first = join(dir, "first");
      const second = join(dir, "second");
      for (const path of [home, first, second]) mkdirSync(path);
      curlServing(first, release(dir, "0.1.0"));
      expect(install(home, [first]).exitCode).toBe(0);
      curlServing(second, release(dir, "0.2.0"));
      cuttingWritesInto(second, join(home, cut));
      expect(install(home, [second]).exitCode).not.toBe(0);
      expect(versionOf(join(home, ".local", "bin", "agent-record"))).toBe("0.1.0\n");
      expect(versionOf(join(home, ".local", "lib", "agent-record", "0.1.0", "agent-record"))).toBe("0.1.0\n");
      for (const written of [join(".local", "bin"), join(".local", "lib", "agent-record", "0.1.0")])
        expect(readdirSync(join(home, written))).toEqual(["agent-record"]);
    });

  for (const printed of ["", "1.2.3.4", "../x", "0.1.0\n../x"])
    test(`refuses a build that reports ${JSON.stringify(printed)} as its version, writing nothing`, () => {
      const dir = scratchDir();
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      for (const path of [home, bin]) mkdirSync(path);
      curlServing(bin, release(dir, printed));
      expect(install(home, [bin])).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          `agent-record install: the downloaded agent-record reports version '${printed.replace("\n", " ")}', not x.y.z; this release is broken, so install a later one\n`,
        ),
      });
      expect(readdirSync(home)).toEqual([]);
    });

  test("keeps only the build it installed once it replaces another", () => {
    const dir = scratchDir();
    const home = join(dir, "home");
    const first = join(dir, "first");
    const second = join(dir, "second");
    for (const path of [home, first, second]) mkdirSync(path);
    curlServing(first, release(dir, "0.1.0"));
    expect(install(home, [first]).exitCode).toBe(0);
    curlServing(second, release(dir, "0.2.0"));
    expect(install(home, [second]).exitCode).toBe(0);
    expect(versionOf(join(home, ".local", "bin", "agent-record"))).toBe("0.2.0\n");
    expect(readdirSync(join(home, ".local", "lib", "agent-record"))).toEqual(["0.2.0"]);
  });
});
