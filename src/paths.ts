import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

const NAME = "agent-record";

export function resolveHomeDir(env: Env = process.env): string {
  const envHome = env.HOME;
  if (envHome && envHome.trim().length > 0) return envHome;
  return homedir();
}

function xdgBase(env: Env, variable: string, fallback: readonly string[]): string {
  const value = env[variable];
  return value && isAbsolute(value) ? value : join(resolveHomeDir(env), ...fallback);
}

export function stateDir(env: Env = process.env): string {
  return join(xdgBase(env, "XDG_STATE_HOME", [".local", "state"]), NAME);
}

export function dbPath(env: Env = process.env): string {
  return join(xdgBase(env, "XDG_DATA_HOME", [".local", "share"]), NAME, "sessions.db");
}

export function syncStampPath(env: Env = process.env): string {
  return join(stateDir(env), "last-sync");
}

export function locksDir(env: Env = process.env): string {
  return join(stateDir(env), "locks");
}

export function claudeDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".claude");
}

export function claudeProjectsDir(env: Env = process.env): string {
  return join(claudeDir(env), "projects");
}

export function codexDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".codex");
}

export function grokDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".grok");
}

export function piSessionsDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".pi", "agent", "sessions");
}

export function ompSessionsDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".omp", "agent", "sessions");
}
