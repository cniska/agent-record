import type { Command, Runtime } from "./cli-contract";
import { parseSwitches } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { SCHEMA_VERSION } from "./db-schema";
import { rebuild, type SyncReport, sync } from "./ingest-sync";
import { type MirrorPass, mirrorArchive } from "./mirror";
import { dbPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";
import { printedSync } from "./sync-view";

type Rebuilt = {
  readonly from: number;
  readonly to: number;
  readonly backup: string;
  readonly unreadCheckouts: readonly string[];
};

type RecordSync = SyncReport & { readonly rebuilt: Rebuilt | null };

function syncRecord(runtime: Runtime): RecordSync {
  const { env } = runtime;
  return withDb(dbPath(env), { ...runtime, admits: "older" }, (db, older) => {
    if (older === null) return { ...sync(db, env), rebuilt: null };
    const { backup, unreadCheckouts, ...report } = rebuild(db, env, "tool files");
    return { ...report, rebuilt: { from: older, to: SCHEMA_VERSION, backup, unreadCheckouts } };
  });
}

export const syncCommand: Command = {
  name: "sync",
  usage: "agent-record sync [--full]",
  summary: "archive every new byte of every tool's session files, read them, and mirror the archive",
  run(args, runtime) {
    const switches = parseSwitches(args, ["full"], syncCommand.usage);
    const { env, now } = runtime;
    const report = withLock(env, () =>
      stampingOutcome(runtime, () => {
        let synced: RecordSync;
        let mirrored: MirrorPass;
        try {
          synced = syncRecord(runtime);
        } finally {
          mirrored = mirrorArchive(env, now());
        }
        return {
          ...synced,
          failures: [...synced.failures, ...mirrored.failures],
          mirror: mirrored.report,
        };
      }),
    );
    return { value: printedSync(report, switches.has("full")), exitCode: 0 };
  },
};
