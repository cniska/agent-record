import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSource, SESSION_SOURCES } from "./ingest-sources";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION_LINE = JSON.stringify({
  type: "session",
  version: 3,
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  timestamp: "2026-01-01T10:00:00.000Z",
  cwd: "/home/dev/widgets",
});

describe("listing sessions", () => {
  test("names each session file by the id in its file name", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-pi-"));
    roots.push(root);
    const dir = join(root, "--home-dev-widgets--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01T10-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000001.jsonl"),
      `${SESSION_LINE}\n`,
    );

    const list = (at: string) => listSource(SESSION_SOURCES.pi, at, {}, () => {});
    expect(list(root).map(({ kind, sessionId }) => ({ kind, sessionId }))).toEqual([
      { kind: "transcript", sessionId: "aaaaaaaa-0000-4000-8000-000000000001" },
    ]);
    expect(list(join(root, "absent"))).toEqual([]);
  });
});
