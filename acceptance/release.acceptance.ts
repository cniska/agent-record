import { afterEach, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  compiledRelease,
  QUERY_RESULT,
  removeScratch,
  runOnCleanMachine,
  SYNC_COMMAND_RESULT,
  scratchHome,
  scratchTempDir,
  succeeded,
  withFixtures,
} from "./cli";
import { LONG } from "./fixture-names";

afterEach(removeScratch);

const BUILD_TIMEOUT_MS = 60_000;

test(
  "AC-60 the release binary, alone on PATH in a fresh home, syncs, answers a query and schedules its own sync",
  () => {
    const binary = compiledRelease(scratchTempDir());
    const home = withFixtures(scratchHome(), [LONG]);

    const synced = succeeded(runOnCleanMachine(home, binary, ["sync"]), "sync", SYNC_COMMAND_RESULT);
    expect(synced.sources).toContainEqual({ tool: "claude", files: 1 });

    const found = succeeded(
      runOnCleanMachine(home, binary, ["query", "search", "parser"]),
      "query",
      QUERY_RESULT,
    );
    expect(found.rows.length).toBeGreaterThan(0);

    const installed = succeeded(
      runOnCleanMachine(home, binary, ["agent", "install"]),
      "agent",
      z.looseObject({ path: z.string() }),
    );
    expect(installed.path).toBe(join(home.root, "Library", "LaunchAgents", "dev.agentrecord.sync.plist"));
    expect(readFileSync(installed.path, "utf8")).toContain(
      `<array>\n    <string>${realpathSync(binary)}</string>\n    <string>sync</string>\n  </array>`,
    );
  },
  BUILD_TIMEOUT_MS,
);
