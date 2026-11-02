import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AGENT_LABEL } from "./agent-launchd";
import type { Env } from "./env";
import { updateCheckPath } from "./paths";
import { DAY_MS } from "./timestamp";
import { Channel, latestSource, upgradeAdvice } from "./update-channel";

const UPDATE_CHECK_TIMEOUT_MS = 1000;

type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

export type UpdateCheck = {
  readonly channel: Channel | null;
  readonly env: Env;
  readonly version: string;
  readonly now: () => Date;
  readonly fetch: Fetch;
  readonly write: (line: string) => void;
};

const LastCheck = z.strictObject({ at: z.iso.datetime(), latest: z.string().nullable() });
type LastCheck = z.infer<typeof LastCheck>;

const LastChecks = z.partialRecord(Channel, LastCheck);
type LastChecks = z.infer<typeof LastChecks>;

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function versionParts(version: string): readonly [number, number, number] | null {
  const match = VERSION.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(latest: string, running: string): boolean {
  const ahead = versionParts(latest);
  const behind = versionParts(running);
  if (ahead === null || behind === null) return false;
  const [major, minor, patch] = ahead;
  const [runningMajor, runningMinor, runningPatch] = behind;
  if (major !== runningMajor) return major > runningMajor;
  if (minor !== runningMinor) return minor > runningMinor;
  return patch > runningPatch;
}

function readLastChecksOrNone(path: string): LastChecks {
  try {
    return LastChecks.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function writeLastChecksOrSkip(path: string, checks: LastChecks): void {
  const partial = `${path}.${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(partial, `${JSON.stringify(checks)}\n`);
    renameSync(partial, path);
  } catch {
    return;
  }
}

function isDue(last: LastCheck | undefined, now: Date): boolean {
  if (last === undefined) return true;
  const since = now.getTime() - Date.parse(last.at);
  return since < 0 || since >= DAY_MS;
}

async function fetchLatestOrNull(channel: Channel, check: UpdateCheck): Promise<string | null> {
  const { url, read } = latestSource(channel);
  try {
    const signal = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
    const response = await check.fetch(url, { signal });
    if (!response.ok) return null;
    const latest = read(await response.text());
    return latest !== null && versionParts(latest) !== null ? latest.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

async function latestKnown(channel: Channel, check: UpdateCheck): Promise<string | null> {
  const path = updateCheckPath(check.env);
  const checks = readLastChecksOrNone(path);
  const last = checks[channel];
  const now = check.now();
  if (!isDue(last, now)) return last?.latest ?? null;
  const latest = (await fetchLatestOrNull(channel, check)) ?? last?.latest ?? null;
  writeLastChecksOrSkip(path, { ...checks, [channel]: { at: now.toISOString(), latest } });
  return latest;
}

function updateLine(channel: Channel, latest: string, running: string): string {
  return `agent-record ${latest} is out (running ${running}): run ${upgradeAdvice(channel)}; if you cannot, tell the user.\n`;
}

export async function announceUpdate(check: UpdateCheck): Promise<void> {
  const { channel, env, version } = check;
  if (channel === null || !env.updateCheck || env.launchdJob === AGENT_LABEL) return;
  const latest = await latestKnown(channel, check);
  if (latest !== null && isNewer(latest, version)) check.write(updateLine(channel, latest, version));
}
