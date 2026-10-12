import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuseRecord } from "./db-contract";
import { scratchEnv } from "./fixtures.test-support";
import { syncStampPath } from "./paths";
import { stampingOutcome } from "./sync-stamp";

describe("stamping a sync's outcome", () => {
  test("records the error a run threw, and throws it on", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-stamp-"));
    try {
      const env = scratchEnv(root);
      const held = refuseRecord("lock_held", { path: "/r/sessions.db", pid: 42 });
      expect(() =>
        stampingOutcome(() => {
          throw held;
        }, env),
      ).toThrow(held);
      expect(JSON.parse(readFileSync(syncStampPath(env), "utf8"))).toMatchObject({
        kind: "failed",
        error: {
          kind: "refusal",
          code: "lock_held",
          meta: { path: "/r/sessions.db", pid: 42 },
          resolve: "run this again once process 42 has ended",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("records an uncoded error as the fault the command reports", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-stamp-"));
    try {
      const env = scratchEnv(root);
      expect(() =>
        stampingOutcome(() => {
          throw new Error("disk vanished");
        }, env),
      ).toThrow("disk vanished");
      expect(JSON.parse(readFileSync(syncStampPath(env), "utf8"))).toMatchObject({
        kind: "failed",
        error: { kind: "fault", code: "command_failed", meta: { detail: "disk vanished" } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
