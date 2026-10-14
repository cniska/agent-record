import { HELD_RECORD_WAIT_MS, runCli } from "./cli-main";
import { launcherOf, parseEnv } from "./env";

await runCli({
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env: parseEnv(process.env),
  invocation: [launcherOf(process.env) ?? process.execPath],
});
