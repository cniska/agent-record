import type { Command } from "./cli-contract";
import { parseSwitches } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";
import { printedSync } from "./sync-view";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "agent-record rebuild [--full]",
  summary: "forget every cursor and read the archive from the start",
  run(args, runtime) {
    const switches = parseSwitches(args, ["full"], rebuildCommand.usage);
    const { env } = runtime;
    const report = withLock(env, () =>
      stampingOutcome(runtime, () =>
        withDb(dbPath(env), { ...runtime, admits: "any" }, (db) => rebuild(db, env, "archive alone")),
      ),
    );
    return { value: printedSync(report, switches.has("full")), exitCode: 0 };
  },
};
