import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChunk } from "./ingest-chunk";

const roots: string[] = [];

function fileOf(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "agent-record-chunk-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, text);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reading a chunk", () => {
  test("reads the whole lines past where it starts", () => {
    const path = fileOf("a\nbb\nccc\n");
    expect(readChunk(path, 9, 2)).toEqual({ lines: ["bb", "ccc"], bytes: 7 });
  });

  test("reads nothing when only a partial line follows", () => {
    const path = fileOf("a\nbb");
    expect(readChunk(path, 4, 2)).toBeNull();
  });
});
