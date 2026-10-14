import { resolve } from "node:path";
import { runCli } from "../src/cli-main";
import { parseEnv } from "../src/env";

const NO_WAIT_MS = 0;

await runCli({
  now: () => new Date(),
  heldRecordWaitMs: NO_WAIT_MS,
  env: parseEnv(process.env),
  bunPath: process.execPath,
  checkout: resolve(import.meta.dir, ".."),
});
