import { resolve } from "node:path";
import { version } from "../package.json";
import { runCli } from "../src/cli-main";
import { parseEnv } from "../src/env";

const NO_WAIT_MS = 0;

await runCli(
  {
    now: () => new Date(),
    heldRecordWaitMs: NO_WAIT_MS,
    env: parseEnv(process.env),
    command: [process.execPath, resolve(import.meta.dir, "..", "src", "cli.ts")],
    version,
    updates: null,
  },
  null,
);
