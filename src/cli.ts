#!/usr/bin/env bun
import { resolve } from "node:path";
import { HELD_RECORD_WAIT_MS, runCli } from "./cli-main";
import { parseEnv } from "./env";

await runCli({
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env: parseEnv(process.env),
  invocation: [process.execPath, resolve(import.meta.dir, "cli.ts")],
});
