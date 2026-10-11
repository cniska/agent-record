import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type Env, syncStampPath } from "./paths";

export type SyncStamp =
  | { kind: "never" }
  | { kind: "synced"; at: Date }
  | { kind: "unreadable"; path: string };

const Stamp = z.iso.datetime();

export function writeSyncStamp(at: Date, env: Env = process.env): void {
  const path = syncStampPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${at.toISOString()}\n`);
}

export function readSyncStamp(env: Env = process.env): SyncStamp {
  const path = syncStampPath(env);
  if (!existsSync(path)) return { kind: "never" };
  const parsed = Stamp.safeParse(readFileSync(path, "utf8").trim());
  if (!parsed.success) return { kind: "unreadable", path };
  return { kind: "synced", at: new Date(parsed.data) };
}
