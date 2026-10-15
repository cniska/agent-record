import type { Runtime } from "./cli-contract";
import { HELD_RECORD_WAIT_MS, runCli } from "./cli-main";
import { parseEnv, releaseCommand } from "./env";

declare const AGENT_RECORD_VERSION: string;

const runtime: Runtime = {
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env: parseEnv(process.env),
  command: [
    releaseCommand({
      raw: process.env,
      argv0: process.argv0,
      cwd: process.cwd(),
      execPath: process.execPath,
    }),
  ],
  version: AGENT_RECORD_VERSION,
};
await runCli(runtime);
