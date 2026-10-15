import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "./db-read.test-support";
import { scratchEnv } from "./fixtures.test-support";
import { runUpdate } from "./update";
import { readUpdateStamp } from "./update-state";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function servingRelease(tag: string): string {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        tag_name: tag,
        assets: [
          { name: "agent-record-darwin-arm64.tar.gz", browser_download_url: "http://localhost:1/build" },
          { name: "agent-record-darwin-arm64.sha256", browser_download_url: "http://localhost:1/sha" },
          { name: "agent-record-linux-x64.tar.gz", browser_download_url: "http://localhost:1/build" },
          { name: "agent-record-linux-x64.sha256", browser_download_url: "http://localhost:1/sha" },
        ],
      }),
  });
  cleanups.push(() => server.stop(true));
  return `http://localhost:${server.port}/releases/latest`;
}

describe("runUpdate", () => {
  test("records a check that fails with a fault as failed, so it is not read as current", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-update-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runtime = {
      ...testRuntime(scratchEnv(root)),
      updates: { releasesUrl: servingRelease("v0.1.0"), executable: join(root, "removed", "agent-record") },
    };
    await expect(runUpdate(runtime, "now")).rejects.toThrow("ENOENT");
    expect(readUpdateStamp(runtime.env)).toMatchObject({
      kind: "failed",
      at: new Date("2026-10-11T12:00:00Z"),
      error: { kind: "fault", code: "command_failed" },
    });
  });
});
