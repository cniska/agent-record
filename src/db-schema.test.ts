import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { TOOLS } from "./ingest-tools";

const PINNED = "17 fee8b7c2d55c0f4d0f23a8a80c51e0ae96a4a500d2c0d7544a9246c467391a7f";

function schema(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

type QualifiedColumn = { readonly name: string; readonly type: string };

function qualifiedColumns(): readonly QualifiedColumn[] {
  const db = schema();
  try {
    return db
      .query<{ table: string; name: string; type: string }, []>(
        `SELECT m.name AS "table", c.name AS name, c.type AS type
         FROM sqlite_master m JOIN pragma_table_xinfo(m.name) c
         WHERE m.type = 'table' AND m.name NOT LIKE 'message_fts%'
         ORDER BY m.name, c.cid`,
      )
      .all()
      .map(({ table, name, type }) => ({ name: `${table}.${name}`, type }));
  } finally {
    db.close();
  }
}

const COLUMNS = qualifiedColumns();

type KeyColumn = {
  readonly table: string;
  readonly key: string;
  readonly seq: number;
  readonly column: string;
};

function columnsByKey(rows: readonly KeyColumn[]): ReadonlyMap<string, readonly string[]> {
  const keys = new Map<string, string[]>();
  for (const { table, key, column } of [...rows].sort((a, b) => a.seq - b.seq)) {
    const id = `${table}:${key}`;
    keys.set(id, [...(keys.get(id) ?? []), column]);
  }
  return keys;
}

test("every foreign key leads an index, so a delete of the rows it references does not scan its table", () => {
  const db = schema();
  const foreignKeys = columnsByKey(
    db
      .query<KeyColumn, []>(
        `SELECT m.name AS "table", f.id AS "key", f.seq AS seq, f."from" AS "column"
         FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table'`,
      )
      .all(),
  );
  const indexes = columnsByKey(
    db
      .query<KeyColumn, []>(
        `SELECT m.name AS "table", l.name AS "key", i.seqno AS seq, i.name AS "column"
         FROM sqlite_master m JOIN pragma_index_list(m.name) l JOIN pragma_index_info(l.name) i
         WHERE m.type = 'table'`,
      )
      .all(),
  );
  const tableOf = (id: string) => id.slice(0, id.indexOf(":"));
  const led = (id: string, columns: readonly string[]) =>
    [...indexes].some(
      ([index, indexed]) =>
        tableOf(index) === tableOf(id) && columns.every((column, position) => indexed[position] === column),
    );
  expect(foreignKeys.size).toBeGreaterThan(0);
  expect(
    [...foreignKeys]
      .filter(([id, columns]) => !led(id, columns))
      .map(([id, columns]) => `${tableOf(id)}(${columns})`),
  ).toEqual([]);
});

test("the schema's version is pinned together with the schema it stands for", () => {
  const digest = new Bun.CryptoHasher("sha256").update(SCHEMA_SQL).digest("hex");
  expect(`${SCHEMA_VERSION} ${digest}`).toBe(PINNED);
});

test("every tool column accepts the tool vocabulary and nothing past it", () => {
  const db = schema();
  const inserts: Record<string, (tool: string, key: string) => void> = {
    source_file: (tool, key) =>
      db.run("INSERT INTO source_file (path, tool, kind, session_id) VALUES (?, ?, 'transcript', ?)", [
        key,
        tool,
        key,
      ]),
    session: (tool, key) => db.run("INSERT INTO session (id, tool) VALUES (?, ?)", [key, tool]),
  };
  try {
    for (const [table, insert] of Object.entries(inserts)) {
      for (const tool of TOOLS) {
        expect(() => insert(tool, `${table}-${tool}`), `${table} accepts ${tool}`).not.toThrow();
      }
      expect(() => insert("cursor", `${table}-cursor`), `${table} refuses cursor`).toThrow(
        /CHECK constraint failed: tool IN/,
      );
    }
  } finally {
    db.close();
  }
});

test("only the record's own clock ends in _at", () => {
  expect(COLUMNS.filter(({ name }) => name.endsWith("_at")).map(({ name }) => name)).toEqual([
    "source_file.ingested_at",
  ]);
});

test("no entity is identified by a row number", () => {
  expect(COLUMNS.filter(({ name, type }) => name.endsWith(".id") && type === "INTEGER")).toEqual([]);
});

test("every flag column says it is one", () => {
  const names = COLUMNS.map(({ name }) => name);
  expect(names.filter((name) => /\.is_/.test(name))).toEqual([
    "message.is_meta",
    "message.is_skill_body",
    "tool_call.is_error",
    "tool_call.is_interrupted",
  ]);
  expect(names).not.toContain("tool_call.interrupted");
});

test("a skill load read by a tool call is stored once", () => {
  const db = schema();
  try {
    db.run("INSERT INTO session (id, tool) VALUES ('s1', 'codex')");
    db.run(
      "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/r.jsonl', 'codex', 'rollout', 's1')",
    );
    db.run(
      "INSERT INTO tool_call (id, session_id, tool_name, src_file) VALUES ('item-1', 's1', 'CommandExecution', '/r.jsonl')",
    );
    const read = () =>
      db.run(
        "INSERT INTO skill_load (session_id, tool_call_id, ts, skill_name, how) VALUES ('s1', 'item-1', '2026-01-01T00:00:00.000Z', 'plan', 'read')",
      );
    read();
    expect(read).toThrow(/UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});

test("a skill load hangs off exactly one message or tool call", () => {
  const db = schema();
  try {
    db.run("INSERT INTO session (id, tool) VALUES ('s1', 'claude')");
    db.run(
      "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')",
    );
    db.run(
      "INSERT INTO message (id, session_id, ts, role, src_file, src_line) VALUES ('m1', 's1', '2026-01-01T00:00:00.000Z', 'assistant', '/f.jsonl', 1)",
    );
    db.run(
      "INSERT INTO tool_call (id, session_id, tool_name, src_file) VALUES ('t1', 's1', 'Skill', '/f.jsonl')",
    );
    const load = (messageId: string | null, toolCallId: string | null) =>
      db.run(
        "INSERT INTO skill_load (session_id, message_id, tool_call_id, ts, skill_name, how) VALUES ('s1', ?, ?, '2026-01-01T00:00:00.000Z', 'plan', 'model')",
        [messageId, toolCallId],
      );
    expect(() => load("m1", "t1")).toThrow(/CHECK constraint failed/);
    expect(() => load(null, null)).toThrow(/constraint failed/);
    expect(() => load("m1", null)).not.toThrow();
  } finally {
    db.close();
  }
});

test("a hook event holds the fields its kind requires", () => {
  const db = schema();
  try {
    db.run("INSERT INTO event_file (path, bytes_ingested, lines_ingested) VALUES ('/e.jsonl', 0, 0)");
    let line = 0;
    const insert = (event: string, fields: Readonly<Record<string, string>>) => {
      line += 1;
      const columns = Object.keys(fields);
      db.run(
        `INSERT INTO hook_event (src_file, src_line, ts, event, session${columns.map((c) => `, ${c}`).join("")})
         VALUES ('/e.jsonl', ?, '2026-10-14T08:00:00.000Z', ?, 's1'${columns.map(() => ", ?").join("")})`,
        [line, event, ...Object.values(fields)],
      );
    };
    expect(() => insert("gate", { gate: "commit", decision: "deny" })).toThrow(/CHECK constraint failed/);
    expect(() => insert("verdict", { verdict: "accept", repo: "/r" })).toThrow(/CHECK constraint failed/);
    expect(() => insert("permission_prompt", {})).toThrow(/CHECK constraint failed/);
    expect(() => insert("permission_denied", { tool: "Bash" })).toThrow(/CHECK constraint failed/);
    expect(() => insert("tag", { tag_key: "route" })).toThrow(/CHECK constraint failed/);
    expect(() => insert("gate", { gate: "commit", decision: "deny", reason: "repo_unclear" })).not.toThrow();
    expect(() => insert("verdict", { verdict: "accept", repo: "/r", fingerprint: "f" })).not.toThrow();
    expect(() => insert("tag", { tag_key: "route", tag_value: "feature" })).not.toThrow();
    expect(() => insert("permission_prompt", { tool: "Bash" })).not.toThrow();
    expect(() => insert("permission_denied", { tool: "Bash", reason: "rule" })).not.toThrow();
  } finally {
    db.close();
  }
});
