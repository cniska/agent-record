import { describe, expect, test } from "bun:test";
import { piSessionLines } from "./fixtures.test-support";
import { parsePiChunk } from "./ingest-parse-pi";

const LINES = piSessionLines().map((line) => JSON.stringify(line));

describe("a Pi or omp session", () => {
  test("records the session's directory and title", () => {
    const { session } = parsePiChunk(LINES, 1);

    expect(session).toContainEqual({
      ts: null,
      cwd: "/home/dev/widgets",
      project: "/home/dev/widgets",
      gitBranch: null,
      cliVersion: null,
      entrypoint: null,
      title: null,
    });
    expect(session).toContainEqual({
      ts: null,
      cwd: null,
      project: null,
      gitBranch: null,
      cliVersion: null,
      entrypoint: null,
      title: "Greet the reader",
    });
  });

  test("takes the session's last time from its latest timestamped line, not its header", () => {
    const times = parsePiChunk(LINES, 1).session.flatMap(({ ts }) => (ts ? [ts] : []));
    expect(times.sort().at(-1)).toBe("2026-01-01T10:02:00.000Z");
  });

  test("records what the owner and the agent said, not its thinking or the harness's reminders", () => {
    const { messages } = parsePiChunk(LINES, 1);

    expect(
      messages.map(({ id, role, text, model, srcLine }) => ({ id, role, text, model, srcLine })),
    ).toEqual([
      { id: "u1", role: "user", text: "add a greeting", model: null, srcLine: 5 },
      { id: "a1", role: "assistant", text: "Reading the readme first.", model: "model-a", srcLine: 6 },
    ]);
  });

  test("records each tool call with its file or command, joined to its result", () => {
    const { toolCalls } = parsePiChunk(LINES, 1);

    expect(toolCalls).toEqual([
      {
        id: "call_1",
        messageId: null,
        model: "model-a",
        attributionSkill: null,
        tsCall: "2026-01-01T10:01:05.000Z",
        tsResult: null,
        toolName: "read",
        skillName: null,
        filePath: "README.md",
        command: null,
        isError: null,
        isInterrupted: null,
        exitCode: null,
        durationMs: null,
        resultBytes: null,
        srcLineCall: 6,
        srcLineResult: null,
      },
      {
        id: "call_2",
        messageId: null,
        model: "model-a",
        attributionSkill: null,
        tsCall: "2026-01-01T10:01:05.000Z",
        tsResult: null,
        toolName: "bash",
        skillName: null,
        filePath: null,
        command: "bun test",
        isError: null,
        isInterrupted: null,
        exitCode: null,
        durationMs: null,
        resultBytes: null,
        srcLineCall: 6,
        srcLineResult: null,
      },
      {
        id: "call_1",
        messageId: null,
        model: null,
        attributionSkill: null,
        tsCall: null,
        tsResult: "2026-01-01T10:01:06.000Z",
        toolName: "read",
        skillName: null,
        filePath: null,
        command: null,
        isError: false,
        isInterrupted: null,
        exitCode: null,
        durationMs: null,
        resultBytes: null,
        srcLineCall: null,
        srcLineResult: 7,
      },
      {
        id: "call_2",
        messageId: null,
        model: null,
        attributionSkill: null,
        tsCall: null,
        tsResult: "2026-01-01T10:01:08.000Z",
        toolName: "bash",
        skillName: null,
        filePath: null,
        command: null,
        isError: true,
        isInterrupted: null,
        exitCode: null,
        durationMs: null,
        resultBytes: null,
        srcLineCall: null,
        srcLineResult: 8,
      },
    ]);
  });

  test("records the tokens each response used, input as pi reports it, apart from cache reads", () => {
    const { usage } = parsePiChunk(LINES, 1);

    expect(usage).toEqual([
      {
        responseId: "resp_1",
        ts: "2026-01-01T10:01:05.000Z",
        model: "model-a",
        inputTokens: 1000,
        cacheReadTokens: 100,
        cacheWriteTokens: 7,
        outputTokens: 20,
        attributionSkill: null,
        messageId: "a1",
      },
    ]);
  });

  test("names the message a response used tokens for only when that message holds text", () => {
    const silent = JSON.stringify({
      type: "message",
      id: "a2",
      timestamp: "2026-01-01T10:03:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "ls" } }],
        model: "model-a",
        usage: { input: 10, output: 2 },
        responseId: "resp_2",
      },
    });
    const { messages, usage } = parsePiChunk([silent], 1);

    expect(messages).toEqual([]);
    expect(usage.map(({ responseId, messageId }) => ({ responseId, messageId }))).toEqual([
      { responseId: "resp_2", messageId: null },
    ]);
  });

  test("records a tool call with an empty name as unnamed", () => {
    const nameless = JSON.stringify({
      type: "message",
      id: "a-nameless",
      timestamp: "2026-01-01T10:05:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call_9", name: "", arguments: {} }] },
    });
    const call = parsePiChunk([nameless], 1).toolCalls.find((t) => t.id === "call_9");
    expect(call).toBeDefined();
    expect(call?.toolName).toBeNull();
  });

  test("keeps no cursor state", () => {
    expect(parsePiChunk(LINES, 1).cursorState).toBeNull();
  });

  test("sets aside a line that does not parse", () => {
    expect(parsePiChunk(["{not json", ...LINES.slice(1, 2)], 10).dropped).toEqual([10]);
  });

  test("sets aside a message line whose read field has the wrong type", () => {
    const wrong = JSON.stringify({
      type: "message",
      id: "m-bad",
      timestamp: "2026-09-16T10:00:00.000Z",
      message: { role: "assistant", responseId: "resp_9", usage: { input: "3" } },
    });
    const parsed = parsePiChunk([wrong, ...LINES.slice(1, 2)], 10);
    expect(parsed.dropped).toEqual([10]);
    expect(parsed.usage.map((u) => u.responseId)).not.toContain("resp_9");
  });
});
