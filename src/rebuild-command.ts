import { type Command, Ran } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";
import { writeSyncStamp } from "./sync-stamp";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "agent-record rebuild",
  summary: "forget every cursor and read all files from the start",
  run(args) {
    parseFlags(args, [], rebuildCommand.usage);
    const report = withLock(() => withDb(dbPath(), rebuild, { forRebuild: true }));
    writeSyncStamp(new Date());
    return new Ran(report, 0);
  },
};
