import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "./cli-contract";
import { type HeldRecordWait, openDb } from "./db";
import type { Env } from "./env";
import { scratchEnv } from "./fixtures.test-support";
import { dbPath } from "./paths";

export const NO_WAIT_MS = 0;

export const NO_WAIT: HeldRecordWait = { heldRecordWaitMs: NO_WAIT_MS };

export function testRuntime(env: Env): Runtime {
  return {
    now: () => new Date("2026-10-11T12:00:00Z"),
    heldRecordWaitMs: NO_WAIT_MS,
    env,
    invocation: ["/opt/homebrew/bin/agent-record"],
  };
}

export function recordWithCommit(): { home: string; env: Env; path: string } {
  const home = mkdtempSync(join(tmpdir(), "agent-record-db-read-"));
  const env = scratchEnv(home);
  const path = dbPath(env);
  const db = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
  db.run(
    "INSERT INTO repo_commit (sha, repo, label, ts, subject) VALUES ('abc123', '/repo', 'acme/demo', '2026-01-01T00:00:00Z', 'feat: stay as written')",
  );
  db.close();
  return { home, env, path };
}

export function fingerprint(path: string): string {
  const db = new Database(path);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

export function stampSchemaVersion(path: string, version: number): void {
  const db = new Database(path);
  db.run(`PRAGMA user_version = ${version}`);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

export async function refusal(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}
