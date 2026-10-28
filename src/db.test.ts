import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CodedError, errorRecord } from "./coded-error";
import { openDb, readRows, recordVersion, SqlFlag, withDb } from "./db";
import { refuseRecord } from "./db-contract";
import { NO_WAIT_MS } from "./db-read.test-support";
import { SCHEMA_VERSION } from "./db-schema";
import type { WriterMode } from "./db-writer.test-support";

const WRITER = join(import.meta.dir, "db-writer.test-support.ts");
const HOLD_MS = 500;

const roots: string[] = [];
const children: Writer[] = [];

afterEach(() => {
  while (children.length > 0) children.pop()?.proc.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchPath(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-record-db-"));
  roots.push(root);
  return join(root, "sessions.db");
}

type Writer = {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  expectLine(line: string): Promise<void>;
  send(): Promise<void>;
};

function spawnWriter(mode: WriterMode, path: string, who: string): Writer {
  const proc = Bun.spawn(["bun", WRITER, mode, path, who], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  const writer: Writer = {
    proc,
    async expectLine(line) {
      while (!buffered.includes("\n")) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error(`${who} exited before printing ${line}: ${await new Response(proc.stderr).text()}`);
        buffered += value;
      }
      const end = buffered.indexOf("\n");
      expect(buffered.slice(0, end)).toBe(line);
      buffered = buffered.slice(end + 1);
    },
    async send() {
      await proc.stdin.write("go\n");
      await proc.stdin.flush();
    },
  };
  children.push(writer);
  return writer;
}

async function exited(writer: Writer): Promise<{ code: number; stderr: string }> {
  const code = await writer.proc.exited;
  return { code, stderr: await new Response(writer.proc.stderr).text() };
}

function committed(path: string): string[] {
  const reader = new Database(path, { readonly: true });
  try {
    return readRows(reader, "SELECT who FROM probe ORDER BY who")
      .all(z.strictObject({ who: z.string() }))
      .map((row) => row.who);
  } finally {
    reader.close();
  }
}

describe("concurrent writers", () => {
  test("two first opens both succeed and stamp the version", async () => {
    const path = scratchPath();
    const first = spawnWriter("initialize", path, "first");
    const second = spawnWriter("initialize", path, "second");
    await Promise.all([first.expectLine("ready"), second.expectLine("ready")]);
    await Promise.all([first.send(), second.send()]);

    expect(await exited(first)).toEqual({ code: 0, stderr: "" });
    expect(await exited(second)).toEqual({ code: 0, stderr: "" });
    const initialized = new Database(path, { readonly: true });
    expect(initialized.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    initialized.close();
  });

  test("a first open beside another first open's held write lock waits for it and stamps the version", async () => {
    const path = scratchPath();
    const holder = new Database(path, { create: true });
    holder.run("BEGIN IMMEDIATE");
    const second = spawnWriter("initialize-contended", path, "second");
    try {
      await second.expectLine("busy");
      await Bun.sleep(HOLD_MS);
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
    expect(await exited(second)).toEqual({ code: 0, stderr: "" });
    const initialized = new Database(path, { readonly: true });
    expect(initialized.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    initialized.close();
  });

  test("a first open can retry after initialization times out on the write lock", () => {
    const path = scratchPath();
    const holder = new Database(path, { create: true });
    holder.run("PRAGMA journal_mode = WAL");
    holder.run("BEGIN IMMEDIATE");
    try {
      expect(() => openDb(path, { heldRecordWaitMs: 50 })).toThrow(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
    const reopened = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
    expect(reopened.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    reopened.close();
  });

  test("a connection closing while a reader holds a snapshot does not hold up another writer", async () => {
    const path = scratchPath();
    const setup = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    setup.close();
    const reader = new Database(path);
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM probe").get();
    try {
      const closer = spawnWriter("close", path, "closer");
      await closer.expectLine("closing");
      await Bun.sleep(HOLD_MS);
      const writer = openDb(path, { heldRecordWaitMs: HOLD_MS });
      writer.run("INSERT INTO probe (who) VALUES ('writer')");
      writer.close();
      reader.run("COMMIT");
      expect(await exited(closer)).toEqual({ code: 0, stderr: "" });
    } finally {
      if (reader.inTransaction) reader.run("ROLLBACK");
      reader.close();
    }
    expect(committed(path)).toEqual(["closer", "writer"]);
  });

  test("an open under another's held write lock completes without waiting and its write waits", async () => {
    const path = scratchPath();
    const setup = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    setup.close();

    const holder = spawnWriter("hold", path, "holder");
    await holder.expectLine("held");
    const opener = spawnWriter("open", path, "opener");
    await opener.expectLine("busy");
    await Bun.sleep(HOLD_MS);
    await holder.send();

    expect(await exited(holder)).toEqual({ code: 0, stderr: "" });
    expect(await exited(opener)).toEqual({ code: 0, stderr: "" });
    expect(committed(path)).toEqual(["holder", "opener"]);
  }, 20_000);

  test("a writer already open waits for another's write lock and both commit", async () => {
    const path = scratchPath();
    const setup = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    setup.close();

    const writer = spawnWriter("write", path, "writer");
    await writer.expectLine("opened");
    const holder = spawnWriter("hold", path, "holder");
    await holder.expectLine("held");
    await writer.send();
    await writer.expectLine("busy");
    await Bun.sleep(HOLD_MS);
    await holder.send();

    expect(await exited(holder)).toEqual({ code: 0, stderr: "" });
    expect(await exited(writer)).toEqual({ code: 0, stderr: "" });
    expect(committed(path)).toEqual(["holder", "writer"]);
  }, 20_000);

  test("a transaction that reads before it writes waits for another's write lock and both commit", async () => {
    const path = scratchPath();
    const setup = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    setup.close();

    const writer = spawnWriter("read-write", path, "writer");
    await writer.expectLine("opened");
    const holder = spawnWriter("hold", path, "holder");
    await holder.expectLine("held");
    await writer.send();
    await writer.expectLine("busy");
    await Bun.sleep(HOLD_MS);
    await holder.send();

    expect(await exited(holder)).toEqual({ code: 0, stderr: "" });
    expect(await exited(writer)).toEqual({ code: 0, stderr: "" });
    expect(committed(path)).toEqual(["holder", "writer"]);
  }, 20_000);

  test("a lock held past the wait fails the writer with SQLITE_BUSY", () => {
    const path = scratchPath();
    const setup = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
    setup.run("CREATE TABLE probe (who TEXT NOT NULL)");
    setup.close();

    const holder = new Database(path);
    holder.run("BEGIN IMMEDIATE");
    const writer = openDb(path, { heldRecordWaitMs: 50 });
    try {
      expect(writer.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 50 });
      let caught: unknown;
      try {
        writer.run("INSERT INTO probe (who) VALUES ('writer')");
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      writer.close();
      holder.run("ROLLBACK");
      holder.close();
    }
  });
});

describe("a writer on a record another process holds", () => {
  test("is refused as busy, naming the record", () => {
    const path = scratchPath();
    openDb(path, { heldRecordWaitMs: NO_WAIT_MS }).close();
    const holder = new Database(path);
    holder.run("PRAGMA locking_mode = EXCLUSIVE");
    holder.run("BEGIN IMMEDIATE");
    try {
      expect(() => withDb(path, { heldRecordWaitMs: NO_WAIT_MS }, () => null)).toThrow(
        expect.objectContaining({ kind: "refusal", code: "record_busy", meta: { path } }),
      );
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
  });
});

describe("a record of another version", () => {
  test("is rebuilt when older, and met by an upgrade through each channel when newer", () => {
    const older = refuseRecord("record_version", { found: 4, expected: 5 });
    const newer = refuseRecord("record_version", { found: 6, expected: 5 });
    expect(older.resolve).toBe("the next agent-record sync rebuilds it, or run agent-record rebuild");
    expect(newer.message).toBe(
      "the record is schema version 6, newer than the version 5 this agent-record reads",
    );
    expect(newer.resolve).toBe(
      "upgrade agent-record the way it was installed: brew upgrade agent-record, npm update -g @cniska/agent-record, or curl -fsSL https://github.com/cniska/agent-record/releases/latest/download/install.sh | sh",
    );
  });

  for (const found of [0, SCHEMA_VERSION + 1]) {
    test(`is refused at version ${found} and left unchanged`, () => {
      const path = scratchPath();
      const old = new Database(path, { create: true });
      old.run("CREATE TABLE legacy (value TEXT)");
      old.run(`PRAGMA user_version = ${found}`);
      old.close();

      expect(() => openDb(path, { heldRecordWaitMs: NO_WAIT_MS })).toThrow(
        expect.objectContaining({ code: "record_version", meta: { found, expected: SCHEMA_VERSION } }),
      );

      const after = new Database(path, { readonly: true });
      expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "legacy" },
      ]);
      expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: found });
      after.close();
    });
  }
});

function stampedOld(): string {
  const path = scratchPath();
  const db = openDb(path, { heldRecordWaitMs: NO_WAIT_MS });
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  db.close();
  return path;
}

describe("opening a database an older schema wrote", () => {
  test("opening for a rebuild leaves the old version in place", () => {
    const db = openDb(stampedOld(), { admits: "any", heldRecordWaitMs: NO_WAIT_MS });

    expect(recordVersion(db)).toBe(SCHEMA_VERSION - 1);
    db.close();
  });

  test("opening for anything else refuses it", () => {
    const path = stampedOld();

    expect(() => openDb(path, { heldRecordWaitMs: NO_WAIT_MS })).toThrow(
      expect.objectContaining({ code: "record_version" }),
    );
  });
});

const read = (use: (db: Database) => unknown): unknown => {
  const db = new Database(":memory:");
  try {
    return use(db);
  } finally {
    db.close();
  }
};

describe("reading rows through a schema", () => {
  test("gives back each row as its schema parses it", () => {
    const Row = z.strictObject({ n: z.number(), flag: SqlFlag });
    expect(read((db) => readRows<[number]>(db, "SELECT ? AS n, 1 AS flag").all(Row, 7))).toEqual([
      { n: 7, flag: true },
    ]);
  });

  test("refuses a row its schema does not take, naming the statement, as a bug", () => {
    let thrown: unknown;
    try {
      read((db) => readRows(db, "SELECT 'seven' AS n").get(z.strictObject({ n: z.number() })));
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof CodedError ? errorRecord(thrown) : thrown).toEqual({
      kind: "fault",
      code: "row_mismatch",
      message:
        "a row of SELECT 'seven' AS n does not match its schema: n: Invalid input: expected number, received string",
      meta: {
        sql: "SELECT 'seven' AS n",
        detail: "n: Invalid input: expected number, received string",
      },
      resolve:
        "stop and hand this error to the owner as a bug in agent-record; no command you run resolves it",
    });
  });
});
