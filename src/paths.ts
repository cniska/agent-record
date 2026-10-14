import { join } from "node:path";
import type { Env } from "./env";

const NAME = "agent-record";

export function stateDir(env: Env): string {
  return join(env.stateHome, NAME);
}

function dataDir(env: Env): string {
  return join(env.dataHome, NAME);
}

export function dbPath(env: Env): string {
  return join(dataDir(env), "sessions.db");
}

export function archiveDir(env: Env): string {
  return join(dataDir(env), "archive");
}

export function syncStampPath(env: Env): string {
  return join(stateDir(env), "last-sync");
}

export function locksDir(env: Env): string {
  return join(stateDir(env), "locks");
}

export function claudeProjectsDir(env: Env): string {
  return join(env.home, ".claude", "projects");
}

export function codexDir(env: Env): string {
  return join(env.home, ".codex");
}

export function grokSessionsDir(env: Env): string {
  return join(env.home, ".grok", "sessions");
}

export function piSessionsDir(env: Env): string {
  return join(env.home, ".pi", "agent", "sessions");
}

export function ompSessionsDir(env: Env): string {
  return join(env.home, ".omp", "agent", "sessions");
}
