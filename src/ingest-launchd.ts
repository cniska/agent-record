import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { invariant } from "./assert";
import { copyBackup } from "./file-backup";
import { refuseIngest } from "./ingest-contract";
import { type Env, resolveHomeDir, stateDir } from "./paths";

export const AGENT_LABEL = "dev.agentrecord.sync";
const INTERVAL_SECONDS = 900;

export function agentPlistPath(env: Env = process.env): string {
  return join(resolveHomeDir(env), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

export function syncLogPath(env: Env = process.env): string {
  return join(stateDir(env), "sync.log");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function agentPlist(bunPath: string, repoDir: string, env: Env = process.env): string {
  const args = [bunPath, "run", join(repoDir, "src", "cli.ts"), "sync"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlText(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlText(repoDir)}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlText(syncLogPath(env))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(syncLogPath(env))}</string>
</dict>
</plist>
`;
}

export type AgentState = "missing" | "stale" | "current";

export type AgentPlan = { path: string; contents: string; state: AgentState };

function agentState(path: string, contents: string): AgentState {
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8") === contents ? "current" : "stale";
}

export function planAgent(env: Env = process.env): AgentPlan {
  const path = agentPlistPath(env);
  const contents = agentPlist(process.execPath, resolve(import.meta.dir, ".."), env);
  return { path, contents, state: agentState(path, contents) };
}

export function installAgent(env: Env = process.env): AgentPlan {
  const plan = planAgent(env);
  if (plan.state === "current") return plan;
  mkdirSync(dirname(plan.path), { recursive: true });
  mkdirSync(dirname(syncLogPath(env)), { recursive: true });
  if (plan.state === "stale") copyBackup(plan.path);
  writeFileSync(plan.path, plan.contents);
  return plan;
}

export function bootstrapCommand(path: string): string {
  return `launchctl bootstrap gui/$(id -u) ${path}`;
}

export function bootoutCommand(): string {
  return `launchctl bootout gui/$(id -u)/${AGENT_LABEL}`;
}

export function agentLoaded(env: Env = process.env): boolean {
  const uid = process.getuid?.();
  invariant(uid !== undefined, "launchd runs only where processes have a user id");
  const args = ["launchctl", "print", `gui/${uid}/${AGENT_LABEL}`];
  try {
    return Bun.spawnSync(args, { env, stdout: "ignore", stderr: "ignore" }).success;
  } catch (error) {
    throw refuseIngest("launchctl_unavailable", {
      command: args.join(" "),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
