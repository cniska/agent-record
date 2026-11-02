import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./env";
import { asUnprivileged, scratchEnv } from "./fixtures.test-support";
import { type Channel, installChannel, upgradeAdvice } from "./update-channel";

const roots: string[] = [];

const locked: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchMachine(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-record-channel-")));
  roots.push(root);
  return scratchEnv(root);
}

function build(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  return path;
}

function channelAt(env: Env, ...segments: string[]): Channel | null {
  return installChannel({ execPath: build(join(env.home, ...segments)), env });
}

describe("the channel a release was installed through", () => {
  test("is Homebrew for a build in the Cellar", () => {
    const env = scratchMachine();
    expect(channelAt(env, "homebrew", "Cellar", "agent-record", "0.3.0", "bin", "agent-record")).toBe(
      "homebrew",
    );
  });

  test("is Homebrew when started through the symlink Homebrew puts on PATH", () => {
    const env = scratchMachine();
    const cellar = build(
      join(env.home, "homebrew", "Cellar", "agent-record", "0.3.0", "bin", "agent-record"),
    );
    const linked = join(env.home, "homebrew", "bin", "agent-record");
    mkdirSync(dirname(linked), { recursive: true });
    symlinkSync(cellar, linked);
    expect(installChannel({ execPath: linked, env })).toBe("homebrew");
  });

  test("is npm for a platform build in a global npm prefix, hoisted or nested", () => {
    const env = scratchMachine();
    const modules = ["prefix", "lib", "node_modules", "@cniska"];
    expect(channelAt(env, ...modules, "agent-record-darwin-arm64", "agent-record")).toBe("npm");
    expect(
      channelAt(
        env,
        ...modules,
        "agent-record",
        "node_modules",
        "@cniska",
        "agent-record-linux-x64",
        "agent-record",
      ),
    ).toBe("npm");
  });

  test("is bun for a platform build in bun's global install", () => {
    const env = scratchMachine();
    expect(
      channelAt(
        env,
        ".bun",
        "install",
        "global",
        "node_modules",
        "@cniska",
        "agent-record-darwin-arm64",
        "agent-record",
      ),
    ).toBe("bun");
  });

  test("is curl for the build install.sh puts in ~/.local/bin", () => {
    const env = scratchMachine();
    expect(channelAt(env, ".local", "bin", "agent-record")).toBe("curl");
  });

  test("is unknown for a build a channel did not place", () => {
    const env = scratchMachine();
    const unknown = [
      ["Downloads", "agent-record"],
      ["project", "node_modules", "@cniska", "agent-record-darwin-arm64", "agent-record"],
      [".npm", "_npx", "a1b2", "node_modules", "@cniska", "agent-record-darwin-arm64", "agent-record"],
      ["prefix", "lib", "node_modules", "@cniska", "agent-record-darwin-arm64", "other"],
      ["Cellar", "other", "0.3.0", "bin", "agent-record"],
      [".local", "bin", "agent-record-old"],
    ];
    for (const segments of unknown)
      expect({ segments, channel: channelAt(env, ...segments) }).toEqual({
        segments,
        channel: null,
      });
  });
});

describe("a channel path the release cannot resolve", () => {
  test("is not that channel, rather than a failure", () => {
    const machine = scratchMachine();
    const sealed = join(machine.home, "sealed");
    const env = { ...machine, bunInstall: join(sealed, ".bun") };
    mkdirSync(join(sealed, ".bun", "install", "global", "node_modules"), { recursive: true });
    const curl = build(join(env.home, ".local", "bin", "agent-record"));
    chmodSync(sealed, 0);
    locked.push(sealed);
    expect(asUnprivileged(env, () => installChannel({ execPath: curl, env }))).toBe("curl");
  });
});

describe("the upgrade a release names", () => {
  test("is its own channel's command", () => {
    expect(upgradeAdvice("homebrew")).toBe("brew upgrade agent-record");
    expect(upgradeAdvice("npm")).toBe("npm update -g @cniska/agent-record");
    expect(upgradeAdvice("bun")).toBe("bun update -g @cniska/agent-record");
    expect(upgradeAdvice("curl")).toBe(
      "curl -fsSL https://github.com/cniska/agent-record/releases/latest/download/install.sh | sh",
    );
  });

  test("lists every channel's command when the channel is unknown", () => {
    expect(upgradeAdvice(null)).toBe(
      "upgrade agent-record the way it was installed: brew upgrade agent-record, npm update -g @cniska/agent-record, bun update -g @cniska/agent-record, or curl -fsSL https://github.com/cniska/agent-record/releases/latest/download/install.sh | sh",
    );
  });
});
