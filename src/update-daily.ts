import { spawn } from "node:child_process";
import type { Command, Runtime } from "./cli-contract";
import { checkIsDue, readUpdateStamp } from "./update-state";

const STAGED_UPDATE = ["update", "--staged"] as const;

export function startDailyCheckIfDue(command: Command, runtime: Runtime): void {
  const { updates, env } = runtime;
  if (updates === null || env.skipUpdate || !command.startsUpdateCheck) return;
  if (!checkIsDue(readUpdateStamp(env), runtime.now())) return;
  spawn(updates.executable, STAGED_UPDATE, { detached: true, stdio: "ignore" }).unref();
}
