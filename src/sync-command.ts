import type { Command } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { type SyncReport, sync } from "./ingest-sync";
import { mirrorArchive } from "./mirror";
import { dbPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";

export const syncCommand: Command = {
  name: "sync",
  usage: "agent-record sync",
  summary: "archive every new byte of every tool's session files, read them, and mirror the archive",
  run(args, runtime) {
    parseFlags(args, [], syncCommand.usage);
    const { env, now } = runtime;
    const report = withLock(env, () =>
      stampingOutcome(runtime, () => {
        let synced: SyncReport;
        try {
          synced = withDb(dbPath(env), runtime, (db) => sync(db, env));
        } catch (error) {
          mirrorArchive(env, now());
          throw error;
        }
        const { report: mirror, failures } = mirrorArchive(env, now());
        return { ...synced, failures: [...synced.failures, ...failures], mirror };
      }),
    );
    return { value: report, exitCode: 0 };
  },
};
