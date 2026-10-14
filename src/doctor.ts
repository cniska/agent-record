import { type AgentPlan, bootoutCommand, bootstrapCommand, planAgent } from "./agent-launchd";
import { unreachable } from "./assert";
import type { Runtime } from "./cli-contract";
import { CodedError, isRefusal } from "./coded-error";
import { readingRecord } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import { dbPath, type Env } from "./paths";
import { readSyncStamp, type SyncStamp } from "./sync-stamp";

const HOUR_MS = 3_600_000;
const SYNC_STOPPED_AFTER_MS = 24 * HOUR_MS;
const SYNC = "agent-record sync";

type Health = {
  readonly name: string;
  readonly state: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly fix: string | null;
};

type DoctorReport = { readonly checks: readonly Health[]; readonly failing: number };

export type DoctorProbes = Runtime & { readonly agentLoaded: (env: Env) => boolean };

function refusalOr<T>(probe: () => T): T | CodedError {
  try {
    return probe();
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return error;
  }
}

function recordHealth(env: Env, heldRecordWaitMs: number): Health {
  const name = "record";
  const read = refusalOr(() => readingRecord(dbPath(env), heldRecordWaitMs, () => null));
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

export function recordDoctor(env: Env, { agentLoaded, now, heldRecordWaitMs }: DoctorProbes): DoctorReport {
  const checks = [
    recordHealth(env, heldRecordWaitMs),
    syncHealth(readSyncStamp(env), now()),
    agentHealth(planAgent(env), () => agentLoaded(env)),
  ];
  return { checks, failing: checks.filter(({ state }) => state === "fail").length };
}
