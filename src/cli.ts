#!/usr/bin/env bun
import { resolve } from "node:path";
import { runCli } from "./cli-main";
import { parseEnv } from "./env";

const HELD_RECORD_WAIT_MS = 5000;

await runCli({
  now: () => new Date(),
  heldRecordWaitMs: HELD_RECORD_WAIT_MS,
  env: parseEnv(process.env),
  bunPath: process.execPath,
  checkout: resolve(import.meta.dir, ".."),
});
