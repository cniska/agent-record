import type { Command } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";

export const rebuildCommand: Command = {
  name: "rebuild",
  startsUpdateCheck: false,
  usage: "agent-record rebuild",
  summary: "forget every cursor and read the archive from the start",
  run(args, runtime) {
    parseFlags(args, [], rebuildCommand.usage);
    const { env } = runtime;
    const report = withLock(env, () =>
      stampingOutcome(runtime, () =>
        withDb(dbPath(env), { ...runtime, admits: "any" }, (db) => rebuild(db, env, "archive alone")),
      ),
    );
    return { value: report, exitCode: 0 };
  },
};
