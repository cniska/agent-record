import type { Command } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { withDb } from "./db";
import { withLock } from "./db-lock";
import { sync } from "./ingest-sync";
import { dbPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";

export const syncCommand: Command = {
  name: "sync",
  usage: "agent-record sync",
  summary: "archive every new byte of every tool's session files and read them",
  run(args) {
    parseFlags(args, [], syncCommand.usage);
    const report = withLock(() => stampingOutcome(() => withDb(dbPath(), sync)));
    return { value: report, exitCode: 0 };
  },
};
