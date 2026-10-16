import { describe, expect, test } from "bun:test";
import { grokUpdate } from "./fixtures.test-support";
import { parseGrokChunk } from "./ingest-parse-grok";

const SESSION = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e11";
const AT = 1700000000000;

function event(update: unknown, eventId: string): unknown {
  return grokUpdate(SESSION, update, eventId, AT);
}

describe("a grok update line", () => {
  test("drops an update line whose read field has the wrong type", () => {
    const bad = event({ sessionUpdate: "tool_call", toolCallId: 7 }, "tool-bad");
    const good = event({ sessionUpdate: "tool_call", toolCallId: "call-9" }, "tool-good");
    const parsed = parseGrokChunk([JSON.stringify(bad), JSON.stringify(good)], 1);
    expect(parsed.dropped).toEqual([1]);
    expect(parsed.toolCalls.map((call) => call.id)).toEqual<string[]>(["call-9"]);
  });

  test("keeps an update line whose content is a list of tool output blocks", () => {
    const content = [{ type: "content", content: { type: "text", text: "output" } }];
    const line = event({ sessionUpdate: "tool_call_update", toolCallId: "call-7", content }, "tool-list");
    const parsed = parseGrokChunk([JSON.stringify(line)], 1);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.toolCalls.map((call) => call.id)).toEqual<string[]>(["call-7"]);
  });

  test("keeps an update line whose optional fields are null", () => {
    const line = event(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-8",
        rawInput: null,
        status: null,
        content: null,
      },
      "tool-null",
    );
    const parsed = parseGrokChunk([JSON.stringify(line)], 1);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.toolCalls.map((call) => call.id)).toEqual<string[]>(["call-8"]);
  });

  test("drops an update line whose event id is empty", () => {
    const line = event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, "");
    const parsed = parseGrokChunk([JSON.stringify(line)], 3);
    expect(parsed.dropped).toEqual([3]);
    expect(parsed.messages).toEqual([]);
  });

  test("reports a tool line with no call id or no time as dropped", () => {
    const call = event({ sessionUpdate: "tool_call", rawInput: { command: "ls" } }, "tool-anon");
    const update = event({ sessionUpdate: "tool_call_update", status: "completed" }, "tool-anon-done");
    const untimed = {
      method: "session/update",
      params: { sessionId: SESSION, update: { sessionUpdate: "tool_call", toolCallId: "call-u" } },
    };
    const parsed = parseGrokChunk(
      [call, update, untimed].map((line) => JSON.stringify(line)),
      4,
    );
    expect(parsed.dropped).toEqual([4, 5, 6]);
    expect(parsed.toolCalls).toEqual([]);
  });

  test("an unfinished update fills in the call's details, and a finished one also its result", () => {
    const running = event(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-5",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
      "tool-5-run",
    );
    const done = event(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-5",
        status: "failed",
        locations: [{ path: "a.ts" }],
        content: [
          {
            type: "content",
            content: { type: "text", text: "Tool `run_terminal_command` was not executed" },
          },
          { type: "diff", path: "a.ts" },
        ],
      },
      "tool-5-done",
    );
    const parsed = parseGrokChunk([JSON.stringify(running), JSON.stringify(done)], 1);
    expect(parsed.toolCalls).toEqual<object[]>([
      { kind: "detail", id: "call-5", toolName: null, filePath: null, command: "ls" },
      { kind: "detail", id: "call-5", toolName: null, filePath: "a.ts", command: null },
      {
        kind: "result",
        id: "call-5",
        ts: "2023-11-14T22:13:20.000Z",
        toolName: null,
        isError: true,
        isInterrupted: null,
        hostRefused: null,
        exitCode: null,
        duration: { kind: "call-to-result" },
        resultBytes: "Tool `run_terminal_command` was not executed".length,
        errorText: "Tool `run_terminal_command` was not executed",
        srcLine: 2,
      },
    ]);
  });

  test("records a load of a skill for each read_file line that names its SKILL.md, and none for another read or an edit", () => {
    const call = (id: string, name: string, target: string, sessionUpdate = "tool_call") =>
      JSON.stringify(
        event(
          {
            sessionUpdate,
            toolCallId: id,
            rawInput: { target_file: target },
            _meta: { "x.ai/tool": { name } },
          },
          `${id}-${sessionUpdate}`,
        ),
      );
    const parsed = parseGrokChunk(
      [
        call("call-s", "read_file", "/home/dev/.agents/skills/plan/SKILL.md"),
        call("call-s", "read_file", "/home/dev/.agents/skills/plan/SKILL.md", "tool_call_update"),
        call("call-r", "read_file", "/home/dev/widgets/README.md"),
        call("call-e", "search_replace", "/home/dev/skills/draft/SKILL.md"),
      ],
      1,
    );
    expect(parsed.skillLoads).toEqual<object[]>([
      {
        kind: "called",
        toolCallId: "call-s",
        ts: "2023-11-14T22:13:20.000Z",
        model: null,
        skillName: "plan",
        how: "read",
      },
      {
        kind: "called",
        toolCallId: "call-s",
        ts: "2023-11-14T22:13:20.000Z",
        model: null,
        skillName: "plan",
        how: "read",
      },
    ]);
  });

  test("reads a finished shell command's exit code, and no other tool's", () => {
    const update = (id: string, status: string, rawOutput: unknown) =>
      JSON.stringify(
        event({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput }, `${id}-${status}`),
      );
    const parsed = parseGrokChunk(
      [
        update("call-a", "in_progress", { type: "Bash", exit_code: 0 }),
        update("call-a", "completed", { type: "Bash", exit_code: 2 }),
        update("call-b", "completed", { type: "GrepSearch", exit_code: 1 }),
        update("call-c", "completed", { type: "FileContent" }),
        update("call-d", "completed", "plain output"),
      ],
      1,
    );
    expect(parsed.dropped).toEqual([]);
    expect(
      parsed.toolCalls.flatMap((call) => (call.kind === "result" ? [[call.id, call.exitCode]] : [])),
    ).toEqual<unknown[]>([
      ["call-a", 2],
      ["call-b", null],
      ["call-c", null],
      ["call-d", null],
    ]);
  });

  test("keeps the text of a failed call or a command that exited non-zero as its error text", () => {
    const update = (id: string, status: string, rawOutput: unknown) =>
      JSON.stringify(
        event(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status,
            rawOutput,
            content: [{ type: "content", content: { type: "text", text: `${id} said why` } }],
          },
          `${id}-${status}`,
        ),
      );
    const parsed = parseGrokChunk(
      [
        update("call-a", "completed", { type: "Bash", exit_code: 2 }),
        update("call-b", "failed", null),
        update("call-c", "completed", { type: "Bash", exit_code: 0 }),
      ],
      1,
    );
    expect(
      parsed.toolCalls.flatMap((call) => (call.kind === "result" ? [[call.id, call.errorText]] : [])),
    ).toEqual<unknown[]>([
      ["call-a", "call-a said why"],
      ["call-b", "call-b said why"],
      ["call-c", null],
    ]);
  });

  test("reports a message line with no time as dropped", () => {
    const untimed = {
      method: "session/update",
      params: {
        sessionId: SESSION,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        _meta: { eventId: "msg-untimed" },
      },
    };
    const parsed = parseGrokChunk([JSON.stringify(untimed)], 2);
    expect(parsed.dropped).toEqual([2]);
    expect(parsed.messages).toEqual([]);
  });

  test("keeps a tool line whose event id is empty, since it does not record one", () => {
    const line = event({ sessionUpdate: "tool_call", toolCallId: "call-3" }, "");
    const parsed = parseGrokChunk([JSON.stringify(line)], 1);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.toolCalls.map((call) => call.id)).toEqual<string[]>(["call-3"]);
  });

  test("keeps no cursor state", () => {
    const line = event({ sessionUpdate: "tool_call", toolCallId: "call-1" }, "tool-1");
    expect(parseGrokChunk([JSON.stringify(line)], 1).cursorState).toBeNull();
  });

  test("reports a message line with no event id as dropped", () => {
    const line = event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, "");
    const parsed = parseGrokChunk([JSON.stringify(line)], 3);
    expect(parsed.dropped).toEqual([3]);
    expect(parsed.messages).toEqual([]);
  });
});
