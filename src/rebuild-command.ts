import type { Command } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "agent-record rebuild",
  summary: "forget every cursor and read the archive from the start",
  run(args) {
    parseFlags(args, [], rebuildCommand.usage);
    const report = withLock(() => stampingOutcome(() => withDb(dbPath(), rebuild, { forRebuild: true })));
    return { value: report, exitCode: 0 };
  },
};
