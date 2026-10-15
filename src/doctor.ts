import { dirname } from "node:path";
import { type AgentPlan, bootoutCommand, bootstrapCommand, planAgent } from "./agent-launchd";
import { unreachable } from "./assert";
import type { ProgramArguments, Runtime } from "./cli-contract";
import { CodedError, isRefusal } from "./coded-error";
import type { HeldRecordWait } from "./db";
import { readingRecord } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import type { Env } from "./env";
import { type MirrorState, readMirror } from "./mirror";
import { dbPath } from "./paths";
import { readSyncStamp, type SyncStamp } from "./sync-stamp";
import { HOUR_MS } from "./timestamp";
import {
  checkIsDue,
  isWanted,
  readRejected,
  readUpdateStamp,
  type StagedBuild,
  stagedBuilds,
  type UpdateStamp,
} from "./update-state";

const SYNC_STOPPED_AFTER_MS = 24 * HOUR_MS;
const MIRROR_STALE_AFTER_MS = 24 * HOUR_MS;
const SYNC = "agent-record sync";
const UPDATE = "agent-record update";
const LIKELY_OFFLINE = "this machine was likely offline";
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

function agentHealth(plan: AgentPlan, command: ProgramArguments, loaded: () => boolean): Health {
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
        detail: `the launchd agent does not run ${[...command, "sync"].join(" ")}, the sync this agent-record schedules`,
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

type UpdateInput =
  | { readonly kind: "checkout" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "release";
      readonly stamp: UpdateStamp;
      readonly staged: readonly StagedBuild[];
      readonly rejected: readonly string[] | CodedError;
    };

function readUpdateInput({ updates, env }: Runtime): UpdateInput {
  if (updates === null) return { kind: "checkout" };
  if (env.skipUpdate) return { kind: "skipped" };
  return {
    kind: "release",
    stamp: readUpdateStamp(env),
    staged: stagedBuilds(env),
    rejected: refusalOr(() => readRejected(env)),
  };
}

function updateHealth(input: UpdateInput, version: string, now: Date): Health {
  const name = "update";
  switch (input.kind) {
    case "checkout":
      return {
        name,
        state: "ok",
        detail: "this agent-record runs from a checkout, which updates through git",
        fix: null,
      };
    case "skipped":
      return { name, state: "ok", detail: "AGENT_RECORD_SKIP_UPDATE=1 turns update checks off", fix: null };
    case "release":
      return releaseUpdateHealth(input, version, now);
    default:
      return unreachable(input);
  }
}

function releaseUpdateHealth(
  { stamp, staged, rejected }: Extract<UpdateInput, { kind: "release" }>,
  version: string,
  now: Date,
): Health {
  const name = "update";
  if (rejected instanceof CodedError)
    return { name, state: "warn", detail: rejected.message, fix: rejected.resolve };
  const waiting = staged.find((build) => isWanted(build.version, version, rejected));
  if (waiting !== undefined)
    return {
      name,
      state: "warn",
      detail: `agent-record ${waiting.version} is staged but this run is ${version}; the next run through the installed agent-record starts it`,
      fix: UPDATE,
    };
  switch (stamp.kind) {
    case "never":
      return { name, state: "warn", detail: `no update check has run; ${LIKELY_OFFLINE}`, fix: UPDATE };
    case "unreadable":
      return { name, state: "warn", detail: `${stamp.path} holds no update check`, fix: UPDATE };
    case "failed":
      return {
        name,
        state: "warn",
        detail: `the last update check failed: ${stamp.error.message}`,
        fix: stamp.error.resolve,
      };
    case "checking":
    case "current":
    case "staged": {
      const hours = Math.round((now.getTime() - stamp.at.getTime()) / HOUR_MS);
      if (checkIsDue(stamp, now))
        return {
          name,
          state: "warn",
          detail: `the last update check began ${hours} hours ago; ${LIKELY_OFFLINE}`,
          fix: UPDATE,
        };
      return {
        name,
        state: "ok",
        detail: `agent-record ${version} is current, checked ${hours} hours ago`,
        fix: null,
      };
    }
    default:
      return unreachable(stamp);
  }
}

export function recordDoctor(probes: DoctorProbes): DoctorReport {
  const { env, agentLoaded, now } = probes;
  const checks = [
    recordHealth(env, probes),
    syncHealth(readSyncStamp(env), now()),
    agentHealth(planAgent(probes), probes.command, agentLoaded),
    mirrorHealth(readMirror(env), now()),
    updateHealth(readUpdateInput(probes), probes.version, now()),
  ];
  return { checks, failing: checks.filter(({ state }) => state === "fail").length };
}
