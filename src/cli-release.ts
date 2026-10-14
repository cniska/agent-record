import type { Runtime } from "./cli-contract";
import { HELD_RECORD_WAIT_MS, runCli } from "./cli-main";
import { launcherOf, parseEnv } from "./env";
import { startDailyCheckIfDue } from "./update-daily";

declare const AGENT_RECORD_VERSION: string;
declare const AGENT_RECORD_RELEASES_URL: string;

const runtime: Runtime = {
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env: parseEnv(process.env),
  command: [launcherOf(process.env) ?? process.execPath],
  version: AGENT_RECORD_VERSION,
  updates: { releasesUrl: AGENT_RECORD_RELEASES_URL, executable: process.execPath },
};
await runCli(runtime, startDailyCheckIfDue);
