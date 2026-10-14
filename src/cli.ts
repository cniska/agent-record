#!/usr/bin/env bun
import { runCli } from "./cli-main";

const HELD_RECORD_WAIT_MS = 5000;

await runCli({ now: () => new Date(), heldRecordWaitMs: HELD_RECORD_WAIT_MS });
