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
    expect(parsed.toolCalls.map((call) => call.id)).toEqual(["call-9"]);
  });

  test("keeps an update line whose content is a list of tool output blocks", () => {
    const content = [{ type: "content", content: { type: "text", text: "output" } }];
    const line = event({ sessionUpdate: "tool_call_update", toolCallId: "call-7", content }, "tool-list");
    const parsed = parseGrokChunk([JSON.stringify(line)], 1);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.toolCalls.map((call) => call.id)).toEqual(["call-7"]);
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
    expect(parsed.toolCalls.map((call) => call.id)).toEqual(["call-8"]);
  });

  test("keeps no cursor state", () => {
    const line = event({ sessionUpdate: "tool_call", toolCallId: "call-1" }, "tool-1");
    expect(parseGrokChunk([JSON.stringify(line)], 1).cursorState).toBeNull();
  });
});
