import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRolloutLines, scratchEnv, writeCodexRollout } from "./fixtures.test-support";
import { listCodexRollouts } from "./ingest-codex-source";

const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parseWithRawState(state: string) {
  const root = mkdtempSync(join(tmpdir(), "agent-record-test-"));
  roots.push(root);
  const env = scratchEnv(root);
  writeCodexRollout(env, "sessions", THREAD);
  const [spec] = listCodexRollouts(env);
  const lines = codexRolloutLines(THREAD, { withIds: true })
    .map((l) => JSON.stringify(l))
    .filter((l) => l.includes("response_item"));
  return spec?.parse(lines, 1, state);
}

describe("listCodexRollouts", () => {
  test("faults on cursor state that fails its schema, since agent-record wrote it", () => {
    expect(() => parseWithRawState(JSON.stringify({ model: 5 }))).toThrow(
      expect.objectContaining({
        kind: "fault",
        code: "cursor_state_corrupt",
        meta: {
          thread: THREAD,
          state: '{"model":5}',
          detail: "model: Invalid input: expected string, received number",
        },
      }),
    );
  });

  test("faults on cursor state that is not JSON", () => {
    expect(() => parseWithRawState("{ cut")).toThrow(
      expect.objectContaining({ kind: "fault", code: "cursor_state_corrupt" }),
    );
  });

  test("carries the model from cursor state that passes its schema", () => {
    const parsed = parseWithRawState(JSON.stringify({ model: "gpt-x" }));
    expect(parsed?.messages.find((m) => m.role === "assistant")?.model).toBe("gpt-x");
  });
});
