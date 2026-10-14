import { describe, expect, test } from "bun:test";
import type { SourceFile } from "./ingest";
import { SessionId } from "./ingest-ids";
import { parentsFirst } from "./ingest-order";

function file(sessionId: string, parentId: string | null = null): SourceFile {
  return {
    path: `/${sessionId}.jsonl`,
    kind: parentId === null ? "transcript" : "subagent",
    sessionId: SessionId.parse(sessionId),
    parentId: parentId === null ? null : SessionId.parse(parentId),
    agentType: null,
    spawnCall: null,
    parse: () => {
      throw new Error("ordering reads no file");
    },
  };
}

const ids = (files: readonly SourceFile[]): string[] => files.map((f) => f.sessionId);

describe("parentsFirst", () => {
  test("puts a child listed before its parent after it", () => {
    expect(ids(parentsFirst([file("child", "parent"), file("parent")]))).toEqual(["parent", "child"]);
  });

  test("puts a grandchild after its parent, listed in reverse", () => {
    expect(ids(parentsFirst([file("c", "b"), file("b", "a"), file("a")]))).toEqual(["a", "b", "c"]);
  });

  test("keeps the listing's order where no parent is listed later", () => {
    const listed = [file("a"), file("orphan", "missing"), file("b", "a"), file("c")];
    expect(parentsFirst(listed)).toEqual(listed);
  });

  test("keeps every file of a cycle", () => {
    expect(ids(parentsFirst([file("a", "b"), file("b", "a")]))).toEqual(["b", "a"]);
  });
});
