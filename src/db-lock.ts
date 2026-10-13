import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuseRecord } from "./db-contract";
import { errorCode } from "./error-read";
import { type Env, locksDir } from "./paths";

const PID = /^[1-9]\d*$/;
const OCCUPIED: ReadonlySet<unknown> = new Set(["EEXIST", "ENOTEMPTY"]);

function holderIsAlive(holder: number | null): holder is number {
  if (holder === null) return false;
  try {
    process.kill(holder, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function holderOf(dir: string, lock: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(dir, "pid"), "utf8").trim();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === undefined || !(error instanceof Error)) throw error;
    throw refuseRecord("lock_unreadable", { path: lock, detail: error.message }, error);
  }
  return PID.test(text) ? Number(text) : null;
}

function tryInstall(staging: string, path: string): boolean {
  try {
    renameSync(staging, path);
    return true;
  } catch (error) {
    if (!OCCUPIED.has(errorCode(error))) throw error;
    return false;
  }
}

function renamedAway(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return false;
  }
}

function clearAbandoned(path: string): number | null {
  const aside = `${path}.stale.${process.pid}`;
  rmSync(aside, { recursive: true, force: true });
  if (!renamedAway(path, aside)) return null;
  let holder: number | null;
  try {
    holder = holderOf(aside, path);
  } catch (error) {
    renameSync(aside, path);
    throw error;
  }
  if (holderIsAlive(holder)) {
    renameSync(aside, path);
    return holder;
  }
  rmSync(aside, { recursive: true, force: true });
  return null;
}

function claim(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "pid"), String(process.pid));
    if (tryInstall(staging, path)) return;
    const holder = holderOf(path, path);
    if (holderIsAlive(holder)) throw refuseRecord("lock_held", { path, pid: holder });
    const living = clearAbandoned(path);
    if (living !== null) throw refuseRecord("lock_held", { path, pid: living });
    if (tryInstall(staging, path)) return;
    const winner = holderOf(path, path);
    if (winner === null) throw refuseRecord("lock_contended", { path });
    throw refuseRecord("lock_held", { path, pid: winner });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function release(path: string): void {
  const dropped = `${path}.released.${process.pid}`;
  if (renamedAway(path, dropped)) rmSync(dropped, { recursive: true, force: true });
}

function withPathLock<T>(path: string, fn: () => T): T {
  claim(path);
  const done = () => release(path);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    done();
    throw error;
  }
  if (result instanceof Promise) result.then(done, done);
  else done();
  return result;
}

export function withLock<T>(fn: () => T, env: Env = process.env): T {
  return withPathLock(join(locksDir(env), "record"), fn);
}
