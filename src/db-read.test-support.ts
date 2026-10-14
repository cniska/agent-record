import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "./cli-contract";
import { openDb } from "./db";
import { dbPath } from "./paths";

export const NO_WAIT_MS = 0;

export const NO_WAIT: Runtime = { now: () => new Date("2026-10-11T12:00:00Z"), heldRecordWaitMs: NO_WAIT_MS };

export function recordWithCommit(): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "agent-record-db-read-"));
  const path = dbPath({ XDG_DATA_HOME: home });
  const db = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
  db.run(
    "INSERT INTO repo_commit (sha, repo, label, ts, subject) VALUES ('abc123', '/repo', 'acme/demo', '2026-01-01T00:00:00Z', 'feat: stay as written')",
  );
  db.close();
  return { home, path };
}

export function fingerprint(path: string): string {
  const db = new Database(path);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

export async function asDataHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
  const before = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = before;
  }
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
