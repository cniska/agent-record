import type { Runtime } from "./cli-contract";
import { HELD_RECORD_WAIT_MS, runCli } from "./cli-main";
import { parseEnv, releaseCommand } from "./env";
import { announceUpdate } from "./update";
import { installChannel } from "./update-channel";

declare const AGENT_RECORD_VERSION: string;

const env = parseEnv(process.env);
const channel = installChannel({ execPath: process.execPath, env });
const runtime: Runtime = {
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env,
  command: [
    releaseCommand({
      raw: process.env,
      argv0: process.argv0,
      cwd: process.cwd(),
      execPath: process.execPath,
    }),
  ],
  version: AGENT_RECORD_VERSION,
  channel,
};
await runCli(runtime);
await announceUpdate({
  channel,
  env,
  version: AGENT_RECORD_VERSION,
  now: runtime.now,
  fetch,
  write: (line) => process.stderr.write(line),
});
