import { dirname } from "node:path";
import { type AgentPlan, bootoutCommand, bootstrapCommand, planAgent } from "./agent-launchd";
import { unreachable } from "./assert";
import type { Runtime } from "./cli-contract";
import { CodedError, isRefusal } from "./coded-error";
import type { HeldRecordWait } from "./db";
import { readingRecord } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import type { Env } from "./env";
import { type MirrorState, readMirror } from "./mirror";
import { dbPath } from "./paths";
import { readSyncStamp, type SyncStamp } from "./sync-stamp";
import { HOUR_MS } from "./timestamp";

const SYNC_STOPPED_AFTER_MS = 24 * HOUR_MS;
const MIRROR_STALE_AFTER_MS = 24 * HOUR_MS;
const SYNC = "agent-record sync";
const SYNC_AND_FIX_MIRROR = `${SYNC}, and fix any mirror failure it reports`;

type Health = {
  readonly name: string;
  readonly state: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly fix: string | null;
};

type DoctorReport = { readonly checks: readonly Health[]; readonly failing: number };

export type DoctorProbes = Runtime & { readonly agentLoaded: () => boolean };

function refusalOr<T>(probe: () => T): T | CodedError {
  try {
    return probe();
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return error;
  }
}

function recordHealth(env: Env, wait: HeldRecordWait): Health {
  const name = "record";
  const read = refusalOr(() => readingRecord(dbPath(env), wait, () => null));
  if (read instanceof CodedError) return { name, state: "fail", detail: read.message, fix: read.resolve };
  return { name, state: "ok", detail: `schema version ${SCHEMA_VERSION}`, fix: null };
}

function syncHealth(stamp: SyncStamp, now: Date): Health {
  const name = "sync";
  switch (stamp.kind) {
    case "never":
      return { name, state: "fail", detail: "no sync has ever finished", fix: SYNC };
    case "unreadable":
      return { name, state: "fail", detail: `${stamp.path} holds no sync outcome`, fix: SYNC };
    case "failed":
      return {
        name,
        state: "fail",
        detail: `the last sync failed: ${stamp.error.message}`,
        fix: stamp.error.resolve,
      };
    case "finished": {
      if (stamp.failures !== null) {
        const { count, first } = stamp.failures;
        return {
          name,
          state: "warn",
          detail: `${count} ${count === 1 ? "file" : "files"} failed in the last sync, first ${first}`,
          fix: `${SYNC}, and read the failures it reports`,
        };
      }
      const age = now.getTime() - stamp.at.getTime();
      const detail = `last sync finished ${Math.round(age / HOUR_MS)} hours ago`;
      if (age > SYNC_STOPPED_AFTER_MS)
        return { name, state: "warn", detail, fix: `${SYNC}, and fix any error it reports` };
      return { name, state: "ok", detail, fix: null };
    }
    default:
      return unreachable(stamp);
  }
}

function agentHealth(plan: AgentPlan, loaded: () => boolean): Health {
  const name = "agent";
  switch (plan.state) {
    case "missing":
      return {
        name,
        state: "warn",
        detail: "no launchd agent, so the record syncs only when something runs agent-record sync",
        fix: "claude plugin install cniska-record@cniska, or agent-record agent install to sync while Claude Code is not running",
      };
    case "stale":
      return {
        name,
        state: "warn",
        detail: "the launchd agent runs a different checkout or Bun than this agent-record",
        fix: `agent-record agent install, then ${bootoutCommand()} and ${bootstrapCommand(plan.path)}`,
      };
    case "current": {
      const answer = refusalOr(loaded);
      if (answer instanceof CodedError)
        return { name, state: "warn", detail: answer.message, fix: answer.resolve };
      if (!answer)
        return {
          name,
          state: "warn",
          detail: "the launchd agent is written but not loaded",
          fix: bootstrapCommand(plan.path),
        };
      return { name, state: "ok", detail: "the launchd agent is loaded", fix: null };
    }
    default:
      return unreachable(plan.state);
  }
}

function mirrorHealth(mirror: MirrorState, now: Date): Health {
  const name = "mirror";
  switch (mirror.kind) {
    case "unreachable":
      return {
        name,
        state: "warn",
        detail: `the archive cannot be mirrored to ${mirror.path}: ${mirror.detail}`,
        fix: `make ${dirname(mirror.path)} reachable (for the default, turn on iCloud Drive), or set AGENT_RECORD_MIRROR to an absolute path whose parent folder exists, then run ${SYNC}`,
      };
    case "never":
      return {
        name,
        state: "warn",
        detail: `no sync has mirrored the whole archive to ${mirror.path} yet`,
        fix: SYNC_AND_FIX_MIRROR,
      };
    case "unreadable":
      return { name, state: "warn", detail: `${mirror.stamp} holds no mirror time`, fix: SYNC };
    case "mirrored": {
      const age = now.getTime() - mirror.at.getTime();
      const detail = `the whole archive was last mirrored to ${mirror.path} ${Math.round(age / HOUR_MS)} hours ago`;
      if (age > MIRROR_STALE_AFTER_MS) return { name, state: "warn", detail, fix: SYNC_AND_FIX_MIRROR };
      return { name, state: "ok", detail, fix: null };
    }
    default:
      return unreachable(mirror);
  }
}

export function recordDoctor(probes: DoctorProbes): DoctorReport {
  const { env, agentLoaded, now } = probes;
  const checks = [
    recordHealth(env, probes),
    syncHealth(readSyncStamp(env), now()),
    agentHealth(planAgent(probes), agentLoaded),
    mirrorHealth(readMirror(env), now()),
  ];
  return { checks, failing: checks.filter(({ state }) => state === "fail").length };
}
