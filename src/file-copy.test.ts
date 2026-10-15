import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameStamp, stampLike } from "./file-copy";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pair(): { source: string; copy: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-record-file-copy-"));
  dirs.push(dir);
  const source = join(dir, "source.jsonl");
  const copy = join(dir, "copy.jsonl");
  writeFileSync(source, '{"a":1}\n');
  writeFileSync(copy, '{"a":1}\n');
  return { source, copy };
}

function anotherTimeInTheSameMillisecond(ms: number): number {
  const whole = Math.trunc(ms);
  return ms - whole < 0.5 ? whole + 0.9 : whole + 0.1;
}

describe("stamping a copy by its source's change time", () => {
  test("a copy stamped like its source matches it", () => {
    const { source, copy } = pair();
    stampLike(copy, statSync(source), "changed");
    expect(sameStamp(statSync(copy), statSync(source), "changed")).toBe(true);
  });

  test("a copy stamped at another time in the same millisecond does not match", () => {
    const { source, copy } = pair();
    const at = anotherTimeInTheSameMillisecond(statSync(source).ctimeMs) / 1000;
    utimesSync(copy, at, at);
    expect(sameStamp(statSync(copy), statSync(source), "changed")).toBe(false);
  });

  test("a copy of another size does not match", () => {
    const { source, copy } = pair();
    writeFileSync(copy, '{"a":10}\n');
    stampLike(copy, statSync(source), "changed");
    expect(sameStamp(statSync(copy), statSync(source), "changed")).toBe(false);
  });
});

describe("stamping a copy by its source's modification time", () => {
  test("a copy stamped at another time in the same millisecond matches", () => {
    const { source, copy } = pair();
    const at = anotherTimeInTheSameMillisecond(statSync(source).mtimeMs) / 1000;
    utimesSync(copy, at, at);
    expect(sameStamp(statSync(copy), statSync(source), "modified")).toBe(true);
  });
});
