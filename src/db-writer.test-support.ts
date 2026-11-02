import { Database } from "bun:sqlite";
import { z } from "zod";
import { unreachable } from "./assert";
import { openDb, withDb, writeTransaction } from "./db";
import { sqliteBusy } from "./db-error";
import { NO_WAIT } from "./db-read.test-support";

const CONTENDED_WAIT_MS = 5000;

const WriterMode = z.enum([
  "hold",
  "write",
  "read-write",
  "open",
  "close",
  "initialize",
  "initialize-contended",
]);

export type WriterMode = z.infer<typeof WriterMode>;

const [mode, path, who] = z.tuple([WriterMode, z.string(), z.string()]).parse(process.argv.slice(2));

function nextLine(): Promise<void> {
  return new Promise((resolve) =>
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    }),
  );
}

function reportBusy(noWaitCall: () => void): void {
  try {
    noWaitCall();
  } catch (error) {
    if (!sqliteBusy(error)) throw error;
    console.log("busy");
    return;
  }
  throw new Error(`${who}: the no-wait call was not refused busy`);
}

function reportBusyOnProbeConnection(call: (probe: Database) => void): void {
  const probe = openDb(path, NO_WAIT);
  try {
    reportBusy(() => call(probe));
  } finally {
    probe.close();
  }
}

function insertWho(db: Database): void {
  db.run("INSERT INTO probe (who) VALUES (?)", [who]);
}

function readThenInsertWho(db: Database): void {
  writeTransaction(db, () => {
    db.query("SELECT count(*) FROM probe").get();
    insertWho(db);
  });
}

async function run(writerMode: WriterMode): Promise<void> {
  switch (writerMode) {
    case "hold": {
      const db = new Database(path);
      db.run("BEGIN IMMEDIATE");
      insertWho(db);
      console.log("held");
      await nextLine();
      db.run("COMMIT");
      db.close();
      return;
    }
    case "write": {
      const db = openDb(path, { heldRecordWaitMs: CONTENDED_WAIT_MS, channel: null });
      console.log("opened");
      await nextLine();
      reportBusyOnProbeConnection(insertWho);
      insertWho(db);
      db.close();
      return;
    }
    case "read-write": {
      const db = openDb(path, { heldRecordWaitMs: CONTENDED_WAIT_MS, channel: null });
      console.log("opened");
      await nextLine();
      reportBusyOnProbeConnection(readThenInsertWho);
      readThenInsertWho(db);
      db.close();
      return;
    }
    case "open": {
      reportBusyOnProbeConnection(insertWho);
      const db = openDb(path, { heldRecordWaitMs: CONTENDED_WAIT_MS, channel: null });
      insertWho(db);
      db.close();
      return;
    }
    case "close":
      withDb(path, { heldRecordWaitMs: CONTENDED_WAIT_MS, channel: null }, (db) => {
        insertWho(db);
        console.log("closing");
      });
      return;
    case "initialize": {
      console.log("ready");
      await nextLine();
      openDb(path, { heldRecordWaitMs: CONTENDED_WAIT_MS, channel: null }).close();
      return;
    }
    case "initialize-contended":
      reportBusy(() => openDb(path, NO_WAIT).close());
      openDb(path, { heldRecordWaitMs: CONTENDED_WAIT_MS, channel: null }).close();
      return;
    default:
      return unreachable(writerMode);
  }
}

await run(mode);
