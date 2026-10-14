import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./assert";
import type { Invocation, Runtime } from "./cli-contract";
import type { Env } from "./env";
import { errorDetail } from "./error-read";
import { copyBackup } from "./file-backup";
import { refuseIngest } from "./ingest-contract";
import { stateDir } from "./paths";

export const AGENT_LABEL = "dev.agentrecord.sync";
const INTERVAL_SECONDS = 900;

export function agentPlistPath(env: Env): string {
  return join(env.home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

function syncLogPath(env: Env): string {
  return join(stateDir(env), "sync.log");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function agentPlist(invocation: Invocation, env: Env): string {
  const args = [...invocation, "sync"];
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

type AgentState = "missing" | "stale" | "current";

export type AgentPlan = { path: string; contents: string; state: AgentState };

function agentState(path: string, contents: string): AgentState {
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8") === contents ? "current" : "stale";
}

export type AgentHost = Pick<Runtime, "env" | "invocation">;

export function planAgent({ env, invocation }: AgentHost): AgentPlan {
  const path = agentPlistPath(env);
  const contents = agentPlist(invocation, env);
  return { path, contents, state: agentState(path, contents) };
}

export function installAgent(host: AgentHost): AgentPlan {
  const plan = planAgent(host);
  if (plan.state === "current") return plan;
  mkdirSync(dirname(plan.path), { recursive: true });
  mkdirSync(dirname(syncLogPath(host.env)), { recursive: true });
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

export function agentLoaded(): boolean {
  const uid = process.getuid?.();
  invariant(uid !== undefined, "launchd runs only where processes have a user id");
  const args = ["print", `gui/${uid}/${AGENT_LABEL}`];
  const run = spawnSync("launchctl", args, { stdio: "ignore" });
  if (run.error)
    throw refuseIngest("launchctl_unavailable", {
      command: `launchctl ${args.join(" ")}`,
      detail: errorDetail(run.error),
    });
  return run.status === 0;
}
