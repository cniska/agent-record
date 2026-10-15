import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LABEL, type AgentHost, agentPlist, agentPlistPath, installAgent } from "./agent-launchd";
import { runCli, scratchEnv } from "./fixtures.test-support";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-record-agent-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host(dir: string): AgentHost {
  return { env: scratchEnv(dir), command: ["/opt/homebrew/bin/agent-record"] };
}

describe("launchd agent", () => {
  test("runs the command's sync by absolute path, because launchd has no PATH to look it up on", () => {
    const plist = agentPlist(
      ["/opt/homebrew/bin/bun", "/Users/x/code/tool/src/cli.ts"],
      scratchEnv(newRoot()),
    );
    expect(plist).toContain(
      "<array>\n    <string>/opt/homebrew/bin/bun</string>\n    <string>/Users/x/code/tool/src/cli.ts</string>\n    <string>sync</string>\n  </array>",
    );
    expect(plist).not.toContain("WorkingDirectory");
  });

  test("runs an installed release by its command alone, so no checkout or Bun is needed", () => {
    const plist = agentPlist(["/opt/homebrew/bin/agent-record"], scratchEnv(newRoot()));
    expect(plist).toContain(
      "<array>\n    <string>/opt/homebrew/bin/agent-record</string>\n    <string>sync</string>\n  </array>",
    );
  });

  test("syncs on a fifteen minute interval and at load", () => {
    const plist = agentPlist(["/usr/local/bin/agent-record"], scratchEnv(newRoot()));
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>900</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("captures output, since nobody is watching an unattended run", () => {
    const dir = newRoot();
    const plist = agentPlist(["/usr/local/bin/agent-record"], scratchEnv(dir));
    expect(plist).toContain(`<string>${join(dir, "state", "agent-record", "sync.log")}</string>`);
  });

  test("runs a checkout's agent under the bun that runs agent-record, not whichever bun the caller's PATH finds", () => {
    const env = scratchEnv(newRoot());
    expect(runCli(env, ["agent", "install"]).exitCode).toBe(0);
    expect(readFileSync(agentPlistPath(env), "utf8")).toContain(
      `<string>${process.execPath}</string>\n    <string>${join(import.meta.dir, "cli.ts")}</string>`,
    );
  });

  test("writes the plist where launchd looks, and reports when it already matches", () => {
    const dir = newRoot();
    const e = host(dir);
    expect(agentPlistPath(e.env)).toBe(join(dir, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`));
    expect(installAgent(e).state).toBe("missing");
    expect(installAgent(e).state).toBe("current");
  });

  test("keeps the previous plists when overwriting one", async () => {
    const dir = newRoot();
    const e = host(dir);
    mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(agentPlistPath(e.env), "<plist>old</plist>");
    installAgent(e);
    await expect(Bun.file(`${agentPlistPath(e.env)}.agent-record-backup`).text()).resolves.toBe(
      "<plist>old</plist>",
    );
    writeFileSync(agentPlistPath(e.env), "<plist>changed</plist>");
    installAgent(e);
    await expect(Bun.file(`${agentPlistPath(e.env)}.agent-record-backup`).text()).resolves.toBe(
      "<plist>old</plist>",
    );
    await expect(Bun.file(`${agentPlistPath(e.env)}.agent-record-backup-2`).text()).resolves.toBe(
      "<plist>changed</plist>",
    );
  });
});
