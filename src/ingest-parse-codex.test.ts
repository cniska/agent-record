import { describe, expect, test } from "bun:test";
import { codexRolloutLines, withoutTimestamp } from "./fixtures.test-support";
import { SessionId, TurnId } from "./ingest-ids";
import { parseCodexChunk } from "./ingest-parse-codex";

const THREAD = SessionId.parse("01a0a651-086e-7150-8650-cef0f4025a58");
const FRESH = { id: THREAD, state: { model: null, turnId: null } };
const modern = codexRolloutLines(THREAD, { withIds: true }).map((l) => JSON.stringify(l));
const legacy = codexRolloutLines(THREAD, { withIds: false }).map((l) => JSON.stringify(l));

describe("parseCodexChunk", () => {
  test("attributes each message to the model of the turn it belongs to", () => {
    const parsed = parseCodexChunk(modern, 1, FRESH);
    const assistants = parsed.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(assistants.map((m) => m.turnId)).toEqual<string[]>(["turn-1", "turn-2"]);
  });

  test("addresses a message with no id by thread and the line it is on", () => {
    const parsed = parseCodexChunk(legacy, 1, FRESH);
    expect(parsed.messages).toHaveLength(3);
    expect(new Set(parsed.messages.map((m) => m.id)).size).toBe(3);
    expect(parsed.messages[0]?.id).toBe<string>(`${THREAD}:3`);
  });

  test("points each message at the line of the file it came from", () => {
    const parsed = parseCodexChunk(modern, 10, FRESH);
    expect(parsed.messages.length).toBeGreaterThan(0);
    for (const message of parsed.messages) {
      const line = JSON.parse(modern[message.srcLine - 10] ?? "{}");
      expect(line.payload?.id).toBe(message.id);
    }
  });

  test("maps the token fields Codex reports, with input excluding cached reads", () => {
    const parsed = parseCodexChunk(modern, 1, FRESH);
    expect(parsed.usage).toHaveLength(1);
    expect(parsed.usage[0]).toMatchObject({
      responseId: `resp-${THREAD}-1`,
      inputTokens: 8034,
      cacheReadTokens: 9984,
      cacheWriteTokens: 0,
      outputTokens: 305,
      model: "gpt-5.6-luna",
    });
  });

  test("drops a token record that reports more cached input than input", () => {
    const record = JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-09-16T10:05:00.000Z",
      payload: {
        thread_id: THREAD,
        response_id: "resp-cached",
        usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 },
      },
    });
    const parsed = parseCodexChunk([record], 7, FRESH);
    expect(parsed.usage).toEqual([]);
    expect(parsed.dropped).toEqual([7]);
  });

  test("resumes the turn in effect when a chunk starts after the turn_context", () => {
    const tail = modern.slice(2);
    const cold = parseCodexChunk(tail, 1, FRESH);
    expect(cold.usage[0]?.model).toBeNull();

    const warm = parseCodexChunk(tail, 1, {
      id: THREAD,
      state: { model: "gpt-5.6-luna", turnId: TurnId.parse("turn-1") },
    });
    expect(warm.usage[0]?.model).toBe("gpt-5.6-luna");
    expect(warm.messages[0]?.turnId).toBe<string>("turn-1");
  });

  test("records a turn that has started and not ended with its start and no end", () => {
    const opened = parseCodexChunk(modern.slice(0, 2), 1, FRESH);
    expect(opened.turns).toEqual<object[]>([
      {
        turnId: "turn-1",
        tsStart: JSON.parse(modern[1] ?? "{}").timestamp,
        tsEnd: null,
        durationMs: null,
        messageCount: null,
        status: "started",
        model: "gpt-5.6-luna",
        timeToFirstTokenMs: null,
      },
    ]);
  });

  test("names an abort that gives no reason as a line it could not read", () => {
    const abort = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-16T10:09:00.000Z",
      payload: { type: "turn_aborted", turn_id: "turn-9" },
    });
    const parsed = parseCodexChunk([abort], 5, FRESH);
    expect(parsed.turns).toEqual([]);
    expect(parsed.dropped).toEqual([5]);
  });

  test("drops a message line whose id is empty, and names an id-less one by its line", () => {
    const message = (id: unknown) =>
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-16T10:09:00.000Z",
        payload: { type: "message", role: "assistant", id, content: [{ type: "output_text", text: "ok" }] },
      });
    const parsed = parseCodexChunk([message(""), message(null)], 5, FRESH);
    expect(parsed.dropped).toEqual([5]);
    expect(parsed.messages.map((m) => m.id)).toEqual<string[]>([`${THREAD}:6`]);
  });

  test("hands back the turn state for the next chunk", () => {
    const parsed = parseCodexChunk(modern, 1, FRESH);
    expect(JSON.parse(parsed.cursorState ?? "{}")).toEqual({ model: "gpt-5.6-sol", turnId: "turn-2" });
  });

  test("takes the session's last time from its latest timestamped line, not its last turn's start", () => {
    const times = parseCodexChunk(modern, 1, FRESH).session.flatMap(({ ts }) => (ts ? [ts] : []));
    expect(times.sort().at(-1)).toBe<string>("2026-09-16T10:09:00.000Z");
  });

  test("counts a timestamped line that carries no payload toward the session's last time", () => {
    const bare = JSON.stringify({ timestamp: "2026-09-16T11:00:00.000Z", type: "event_msg" });
    const parsed = parseCodexChunk([...modern, bare], 1, FRESH);
    const times = parsed.session.flatMap(({ ts }) => (ts ? [ts] : []));
    expect({ latest: times.sort().at(-1), dropped: parsed.dropped }).toEqual<object>({
      latest: "2026-09-16T11:00:00.000Z",
      dropped: [],
    });
  });

  test("takes session facts from session_meta", () => {
    const parsed = parseCodexChunk(modern, 1, FRESH);
    expect(parsed.session.find((facts) => facts.gitBranch !== null)).toMatchObject({
      cwd: "/Users/x/code/demo",
      gitBranch: "main",
      cliVersion: "0.154.0",
      entrypoint: "codex-tui",
    });
  });
  test("marks a typed prompt apart from what the harness injected", () => {
    const parsed = parseCodexChunk(modern, 1, FRESH);
    const typed = parsed.messages.find((m) => m.text === "add the parser");
    expect(typed?.promptSource).toBe("typed");

    const withInjected = parseCodexChunk(
      [
        ...modern,
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-16T10:09:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /Users/x/code/demo" }],
          },
        }),
      ],
      1,
      FRESH,
    );
    const rules = withInjected.messages.find((m) => m.text?.startsWith("# AGENTS.md"));
    expect(rules?.promptSource).toBe("system");
  });

  test("refuses a line with no timestamp rather than writing its rows untimed", () => {
    const untimed = codexRolloutLines(THREAD, { withIds: true }).map((line, index) => {
      if (index !== 3 && index !== 4) return JSON.stringify(line);
      return withoutTimestamp(line);
    });
    const parsed = parseCodexChunk(untimed, 1, FRESH);
    expect(parsed.dropped).toEqual([4, 5]);
    expect(parsed.messages.map((m) => m.ts)).toEqual<string[]>([
      "2026-09-16T10:03:00.000Z",
      "2026-09-16T10:07:00.000Z",
    ]);
    expect(parsed.usage).toEqual([]);
  });

  test("drops a line whose read field has the wrong type, and writes no row from it", () => {
    const completed = (exitCode: unknown) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-16T10:00:00.000Z",
        payload: {
          type: "item_completed",
          item: { id: "item-1", type: "CommandExecution", exit_code: exitCode },
        },
      });
    const parsed = parseCodexChunk([completed("1"), completed(1)], 1, FRESH);
    expect(parsed.dropped).toEqual([1]);
    expect(parsed.toolCalls).toMatchObject([
      { kind: "call", id: "item-1" },
      { kind: "result", id: "item-1", exitCode: 1 },
    ]);
  });

  test("reports a completed tool item with no id as dropped", () => {
    const anonymous = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-16T10:00:00.000Z",
      payload: { type: "item_completed", item: { type: "CommandExecution", command: "ls" } },
    });
    const parsed = parseCodexChunk([anonymous], 3, FRESH);
    expect(parsed.dropped).toEqual([3]);
    expect(parsed.toolCalls).toEqual([]);
  });

  test("keeps a line whose empty id is one it does not record", () => {
    const usage = JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-09-16T10:00:00.000Z",
      payload: { id: "", response_id: "resp-7", usage: { input_tokens: 5 } },
    });
    const parsed = parseCodexChunk([usage], 1, FRESH);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.usage.map((u) => u.responseId)).toEqual<string[]>(["resp-7"]);
  });

  test("ties a skill file read by a command to the tool call that read it", () => {
    const read = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-16T10:00:00.000Z",
      payload: {
        type: "item_completed",
        item: { id: "item-7", type: "CommandExecution", command: "cat skills/plan/SKILL.md" },
      },
    });
    const parsed = parseCodexChunk([read], 1, FRESH);
    expect(parsed.skillLoads).toEqual<object[]>([
      {
        kind: "called",
        toolCallId: "item-7",
        ts: "2026-09-16T10:00:00.000Z",
        model: null,
        skillName: "plan",
        how: "read",
      },
    ]);
    expect(parsed.toolCalls).toMatchObject([
      { kind: "call", id: "item-7", command: "cat skills/plan/SKILL.md" },
      { kind: "result", id: "item-7" },
    ]);
  });

  test("keeps lines whose model, turn id, usage and status are null", () => {
    const at = "2026-09-16T10:00:00.000Z";
    const parsed = parseCodexChunk(
      [
        JSON.stringify({ type: "turn_context", timestamp: at, payload: { model: null, turn_id: null } }),
        JSON.stringify({
          type: "token_usage_record",
          timestamp: at,
          payload: { response_id: "r-1", usage: null },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: at,
          payload: { type: "item_completed", item: { id: "i-1", type: "FileChange", status: null } },
        }),
      ],
      1,
      FRESH,
    );
    expect(parsed.dropped).toEqual([]);
    expect(parsed.usage).toMatchObject([{ responseId: "r-1", outputTokens: 0 }]);
    expect(parsed.toolCalls).toMatchObject([
      { kind: "call", id: "i-1" },
      { kind: "result", id: "i-1", isError: null },
    ]);
  });

  test("keeps a message line whose content is null", () => {
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-16T10:00:00.000Z",
      payload: { type: "message", role: "assistant", content: null },
    });
    const parsed = parseCodexChunk([line], 6, FRESH);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.messages).toMatchObject([{ id: `${THREAD}:6`, role: "assistant" }]);
  });

  test("keeps a message line whose payload id and content blocks are null", () => {
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-16T10:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        id: null,
        content: [null, { type: "input_text", text: "hi" }],
      },
    });
    const parsed = parseCodexChunk([line], 4, FRESH);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.messages).toMatchObject([{ id: `${THREAD}:4`, text: "hi" }]);
  });

  test("reports a token record with no response id and a finished turn with no turn id as dropped", () => {
    const at = "2026-09-16T10:00:00.000Z";
    const usage = JSON.stringify({
      type: "token_usage_record",
      timestamp: at,
      payload: { usage: { input_tokens: 5 } },
    });
    const finished = JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "task_complete" } });
    const parsed = parseCodexChunk([usage, finished], 1, FRESH);
    expect(parsed.dropped).toEqual([1, 2]);
    expect(parsed.usage).toEqual([]);
    expect(parsed.turns).toEqual([]);
  });
});
