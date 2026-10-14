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
      gitBranch: null,
      cliVersion: null,
      entrypoint: null,
      title: null,
    });
    expect(session).toContainEqual({
      ts: null,
      cwd: null,
      gitBranch: null,
      cliVersion: null,
      entrypoint: null,
      title: "Greet the reader",
    });
  });

  test("takes the session's last time from its latest timestamped line, not its header", () => {
    const times = parsePiChunk(LINES, 1).session.flatMap(({ ts }) => (ts ? [ts] : []));
    expect(times.sort().at(-1)).toBe<string>("2026-01-01T10:02:00.000Z");
  });

  test("records what the owner and the agent said, not its thinking or the harness's reminders", () => {
    const { messages } = parsePiChunk(LINES, 1);

    expect(
      messages.map(({ id, role, text, model, srcLine }) => ({ id, role, text, model, srcLine })),
    ).toEqual<object[]>([
      { id: "u1", role: "user", text: "add a greeting", model: null, srcLine: 5 },
      { id: "a1", role: "assistant", text: "Reading the readme first.", model: "model-a", srcLine: 6 },
    ]);
  });

  test("records each tool call with its file or command, joined to its result", () => {
    const { toolCalls } = parsePiChunk(LINES, 1);

    expect(toolCalls).toEqual<object[]>([
      {
        kind: "call",
        id: "call_1",
        ts: "2026-01-01T10:01:05.000Z",
        messageId: null,
        toolName: "read",
        skillName: null,
        filePath: "README.md",
        command: null,
        model: "model-a",
        attributionSkill: null,
        srcLine: 6,
      },
      {
        kind: "call",
        id: "call_2",
        ts: "2026-01-01T10:01:05.000Z",
        messageId: null,
        toolName: "bash",
        skillName: null,
        filePath: null,
        command: "bun test",
        model: "model-a",
        attributionSkill: null,
        srcLine: 6,
      },
      {
        kind: "result",
        id: "call_1",
        ts: "2026-01-01T10:01:06.000Z",
        toolName: "read",
        isError: false,
        isInterrupted: null,
        exitCode: null,
        durationMs: null,
        resultBytes: null,
        srcLine: 7,
      },
      {
        kind: "result",
        id: "call_2",
        ts: "2026-01-01T10:01:08.000Z",
        toolName: "bash",
        isError: true,
        isInterrupted: null,
        exitCode: null,
        durationMs: null,
        resultBytes: null,
        srcLine: 8,
      },
    ]);
  });

  test("records the tokens each response used, input as pi reports it, apart from cache reads", () => {
    const { usage } = parsePiChunk(LINES, 1);

    expect(usage).toEqual<object[]>([
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
    expect(usage.map(({ responseId, messageId }) => ({ responseId, messageId }))).toEqual<object[]>([
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

  test("reads a failed command's exit code from omp's details, or else from the line pi ends its output with", () => {
    const result = (id: string, isError: boolean, text: string, details: unknown = undefined) =>
      JSON.stringify({
        type: "message",
        id: `r-${id}`,
        timestamp: "2026-01-01T10:05:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName: "bash",
          isError,
          content: [{ type: "text", text }],
          details,
        },
      });
    const parsed = parsePiChunk(
      [
        result("call_a", true, "boom\n\nCommand exited with code 2"),
        result("call_b", true, "boom\n\nWall time: 0.54 seconds\n\nCommand exited with code 1", {
          timeoutSeconds: 120,
          exitCode: 1,
        }),
        result("call_c", true, "boom", { exitCode: 3 }),
        result("call_d", true, "Command exited with code 4\nthen more"),
        result("call_e", false, "Command exited with code 5"),
        result("call_f", true, "Skipped due to queued user message.", { __synthetic: true }),
      ],
      1,
    );
    expect(parsed.dropped).toEqual([]);
    expect(
      parsed.toolCalls.map((call) => [call.id, call.kind === "result" ? call.exitCode : "call"]),
    ).toEqual([
      ["call_a", 2],
      ["call_b", 1],
      ["call_c", 3],
      ["call_d", null],
      ["call_e", null],
      ["call_f", null],
    ]);
  });

  test("reports a tool result with no call id or no time as dropped", () => {
    const orphan = JSON.stringify({
      type: "message",
      id: "r-orphan",
      timestamp: "2026-01-01T10:05:00.000Z",
      message: { role: "toolResult", toolName: "bash", isError: false },
    });
    const untimed = JSON.stringify({
      type: "message",
      id: "r-untimed",
      message: { role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false },
    });
    const parsed = parsePiChunk([orphan, untimed], 6);
    expect(parsed.dropped).toEqual([6, 7]);
    expect(parsed.toolCalls).toEqual([]);
  });

  test("drops a message line whose id is empty", () => {
    const unnamed = JSON.stringify({
      type: "message",
      id: "",
      timestamp: "2026-01-01T10:05:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "who am I" }] },
    });
    const parsed = parsePiChunk([unnamed], 4);
    expect(parsed.dropped).toEqual([4]);
    expect(parsed.messages).toEqual([]);
  });

  test("reports an assistant line with a tool call that has no id, or with no time, as dropped", () => {
    const anonymous = JSON.stringify({
      type: "message",
      id: "a-anon",
      timestamp: "2026-01-01T10:05:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
    });
    const untimed = JSON.stringify({
      type: "message",
      id: "a-untimed",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call_4", name: "bash" }] },
    });
    const parsed = parsePiChunk([anonymous, untimed], 3);
    expect(parsed.dropped).toEqual([3, 4]);
    expect(parsed.toolCalls).toEqual([]);
  });

  test("keeps a line whose empty id is one it does not record", () => {
    const session = JSON.stringify({ type: "session", id: "", cwd: "/home/dev/widgets" });
    const result = JSON.stringify({
      type: "message",
      id: "",
      timestamp: "2026-01-01T10:05:00.000Z",
      message: { role: "toolResult", toolCallId: "call_1", toolName: "read", responseId: "" },
    });
    const parsed = parsePiChunk([session, result], 1);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.toolCalls.map((call) => call.id)).toEqual<string[]>(["call_1"]);
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

  test("reports a session line with no working directory and a title line with an empty title as dropped", () => {
    const session = JSON.stringify({ type: "session", id: "s-1" });
    const title = JSON.stringify({ type: "title", title: "" });
    const parsed = parsePiChunk([session, title], 2);
    expect(parsed.dropped).toEqual([2, 3]);
    expect(parsed.session.map((facts) => facts.cwd ?? facts.title)).toEqual([]);
  });
});
