import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LABEL } from "./agent-launchd";
import type { Env } from "./env";
import { scratchEnv } from "./fixtures.test-support";
import { stateDir, updateCheckPath } from "./paths";
import { DAY_MS, HOUR_MS } from "./timestamp";
import { announceUpdate, type UpdateCheck } from "./update";
import type { Channel } from "./update-channel";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-11-02T12:00:00.000Z");
const RUNNING = "0.3.0";

const FORMULA = (tag: string) => `class AgentRecord < Formula
  on_macos do
    on_arm do
      url "https://github.com/cniska/agent-record/releases/download/${tag}/agent-record-darwin-arm64.tar.gz"
    end
  end
  on_linux do
    on_intel do
      url "https://github.com/cniska/agent-record/releases/download/${tag}/agent-record-linux-x64.tar.gz"
    end
  end
end
`;

type Served = Readonly<Record<string, Response | Error>>;

const SOURCES = {
  formula: "https://raw.githubusercontent.com/cniska/homebrew-tap/main/Formula/agent-record.rb",
  registry: "https://registry.npmjs.org/@cniska/agent-record/latest",
  release: "https://api.github.com/repos/cniska/agent-record/releases/latest",
} as const;

type Machine = { readonly env: Env; readonly asked: string[]; readonly lines: string[] };

function scratchMachine(): Machine {
  const root = mkdtempSync(join(tmpdir(), "agent-record-update-"));
  roots.push(root);
  return { env: { ...scratchEnv(root), updateCheck: true }, asked: [], lines: [] };
}

function checkOn(
  machine: Machine,
  channel: Channel | null,
  served: Served,
  overrides: Partial<UpdateCheck> = {},
): UpdateCheck {
  return {
    channel,
    env: machine.env,
    version: RUNNING,
    now: () => NOW,
    fetch: (url, { signal }) => {
      machine.asked.push(url);
      expect(signal).toBeInstanceOf(AbortSignal);
      const answer = served[url];
      if (answer === undefined) return Promise.reject(new Error(`nothing serves ${url}`));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    write: (line) => machine.lines.push(line),
    ...overrides,
  };
}

const json = (value: unknown) => new Response(JSON.stringify(value));

function lastChecks(machine: Machine): unknown {
  return JSON.parse(readFileSync(updateCheckPath(machine.env), "utf8"));
}

function plantChecks(machine: Machine, checks: unknown): void {
  mkdirSync(stateDir(machine.env), { recursive: true });
  writeFileSync(updateCheckPath(machine.env), JSON.stringify(checks));
}

describe("the update check", () => {
  test("asks each channel for its latest version and prints one line naming its upgrade", async () => {
    const cases = [
      {
        channel: "homebrew",
        served: { [SOURCES.formula]: new Response(FORMULA("v0.3.1")) },
        upgrade: "brew upgrade agent-record",
      },
      {
        channel: "npm",
        served: { [SOURCES.registry]: json({ version: "0.3.1" }) },
        upgrade: "npm update -g @cniska/agent-record",
      },
      {
        channel: "bun",
        served: { [SOURCES.registry]: json({ version: "0.3.1" }) },
        upgrade: "bun update -g @cniska/agent-record",
      },
      {
        channel: "curl",
        served: { [SOURCES.release]: json({ tag_name: "v0.3.1" }) },
        upgrade: "curl -fsSL https://github.com/cniska/agent-record/releases/latest/download/install.sh | sh",
      },
    ] as const;
    for (const { channel, served, upgrade } of cases) {
      const machine = scratchMachine();
      await announceUpdate(checkOn(machine, channel, served));
      expect({ channel, lines: machine.lines, checks: lastChecks(machine) }).toEqual({
        channel,
        lines: [`agent-record 0.3.1 is out (running 0.3.0): run ${upgrade}; if you cannot, tell the user.\n`],
        checks: { [channel]: { at: NOW.toISOString(), latest: "0.3.1" } },
      });
    }
  });

  test("prints nothing when the running version is the latest or newer", async () => {
    for (const latest of ["0.3.0", "0.2.9", "v0.3.0"]) {
      const machine = scratchMachine();
      await announceUpdate(checkOn(machine, "curl", { [SOURCES.release]: json({ tag_name: latest }) }));
      expect({ latest, lines: machine.lines }).toEqual({ latest, lines: [] });
    }
  });

  test("compares each part of the version as a number", async () => {
    for (const latest of ["1.0.0", "0.10.0", "0.3.10"]) {
      const machine = scratchMachine();
      await announceUpdate(checkOn(machine, "npm", { [SOURCES.registry]: json({ version: latest }) }));
      expect({ latest, lines: machine.lines.length }).toEqual({ latest, lines: 1 });
    }
  });

  test("asks at most once a day, and prints the known latest on every command meanwhile", async () => {
    const machine = scratchMachine();
    await announceUpdate(checkOn(machine, "npm", { [SOURCES.registry]: json({ version: "0.3.1" }) }));
    const later = new Date(NOW.getTime() + DAY_MS - HOUR_MS);
    await announceUpdate(checkOn(machine, "npm", {}, { now: () => later }));
    expect(machine.asked).toEqual([SOURCES.registry]);
    expect(machine.lines).toHaveLength(2);

    const nextDay = new Date(NOW.getTime() + DAY_MS);
    await announceUpdate(
      checkOn(machine, "npm", { [SOURCES.registry]: json({ version: "0.3.2" }) }, { now: () => nextDay }),
    );
    expect(machine.asked).toEqual([SOURCES.registry, SOURCES.registry]);
    expect(machine.lines.at(-1)).toStartWith("agent-record 0.3.2 is out");
  });

  test("asks again when the last check's time lies in the future", async () => {
    const machine = scratchMachine();
    plantChecks(machine, { npm: { at: new Date(NOW.getTime() + HOUR_MS).toISOString(), latest: null } });
    await announceUpdate(checkOn(machine, "npm", { [SOURCES.registry]: json({ version: "0.3.0" }) }));
    expect(machine.asked).toEqual([SOURCES.registry]);
  });

  test("counts a failed, refused, timed-out or unreadable check as the day's check, printing nothing new", async () => {
    const failures: readonly Served[] = [
      {},
      { [SOURCES.registry]: new DOMException("The operation timed out.", "TimeoutError") },
      { [SOURCES.registry]: new Response("not found", { status: 404 }) },
      { [SOURCES.registry]: new Response("<html>") },
      { [SOURCES.registry]: json({ version: "latest" }) },
    ];
    for (const served of failures) {
      const machine = scratchMachine();
      await announceUpdate(checkOn(machine, "npm", served));
      expect({ lines: machine.lines, checks: lastChecks(machine) }).toEqual({
        lines: [],
        checks: { npm: { at: NOW.toISOString(), latest: null } },
      });
    }
  });

  test("keeps the latest it knew when the day's check fails", async () => {
    const machine = scratchMachine();
    const yesterday = new Date(NOW.getTime() - DAY_MS).toISOString();
    plantChecks(machine, { npm: { at: yesterday, latest: "0.3.1" } });
    await announceUpdate(checkOn(machine, "npm", {}));
    expect(machine.lines).toHaveLength(1);
    expect(lastChecks(machine)).toEqual({ npm: { at: NOW.toISOString(), latest: "0.3.1" } });
  });

  test("reads a formula whose platforms pin different tags as no version", async () => {
    const machine = scratchMachine();
    const split = FORMULA("v0.3.1").replace("v0.3.1/agent-record-linux", "v0.3.0/agent-record-linux");
    await announceUpdate(checkOn(machine, "homebrew", { [SOURCES.formula]: new Response(split) }));
    expect(machine.lines).toEqual([]);
  });

  test("keeps each channel's check apart, so another channel's latest never names this one's upgrade", async () => {
    const machine = scratchMachine();
    plantChecks(machine, { homebrew: { at: NOW.toISOString(), latest: "0.3.1" } });
    await announceUpdate(checkOn(machine, "curl", { [SOURCES.release]: json({ tag_name: "v0.3.0" }) }));
    expect(machine.lines).toEqual([]);
    expect(lastChecks(machine)).toEqual({
      homebrew: { at: NOW.toISOString(), latest: "0.3.1" },
      curl: { at: NOW.toISOString(), latest: "0.3.0" },
    });
  });

  test("starts over from a state file it cannot read", async () => {
    const machine = scratchMachine();
    plantChecks(machine, "garbage");
    await announceUpdate(checkOn(machine, "curl", { [SOURCES.release]: json({ tag_name: "v0.3.1" }) }));
    expect(machine.lines).toHaveLength(1);
  });

  test("still prints when the state directory cannot be written", async () => {
    const machine = scratchMachine();
    writeFileSync(join(machine.env.stateHome), "a file where the directory should be");
    await announceUpdate(checkOn(machine, "curl", { [SOURCES.release]: json({ tag_name: "v0.3.1" }) }));
    expect(machine.lines).toHaveLength(1);
  });

  test("does nothing for an unknown channel, when the check is off, or in the launchd sync", async () => {
    const served = { [SOURCES.release]: json({ tag_name: "v0.3.1" }) };
    const unknown = scratchMachine();
    await announceUpdate(checkOn(unknown, null, served));
    const off = scratchMachine();
    await announceUpdate(checkOn(off, "curl", served, { env: { ...off.env, updateCheck: false } }));
    const launchd = scratchMachine();
    await announceUpdate(
      checkOn(launchd, "curl", served, { env: { ...launchd.env, launchdJob: AGENT_LABEL } }),
    );
    for (const machine of [unknown, off, launchd]) {
      expect({ asked: machine.asked, lines: machine.lines }).toEqual({ asked: [], lines: [] });
      expect(existsSync(updateCheckPath(machine.env))).toBe(false);
    }
  });
});
