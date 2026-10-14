import { HELD_RECORD_WAIT_MS, runCli } from "./cli-main";
import { launcherOf, parseEnv } from "./env";

declare const AGENT_RECORD_VERSION: string;

await runCli({
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env: parseEnv(process.env),
  command: [launcherOf(process.env) ?? process.execPath],
  version: AGENT_RECORD_VERSION,
});
