import { describe, expect, test } from "bun:test";
import {
  claudeTranscriptLines,
  codexRolloutLines,
  grokUpdate,
  piSessionLines,
} from "./fixtures.test-support";
import { SessionId } from "./ingest-ids";
import { parseClaudeChunk } from "./ingest-parse-claude";
import { parseCodexChunk } from "./ingest-parse-codex";
import { parseGrokChunk } from "./ingest-parse-grok";
import { parsePiChunk } from "./ingest-parse-pi";
import { ParsedChunk } from "./ingest-session-records";

const THREAD = SessionId.parse("01a0a651-086e-7150-8650-cef0f4025a58");
const GROK_SESSION = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e11";
const AT = 1700000000000;

function jsonLines(lines: unknown[]): string[] {
  return lines.map((line) => JSON.stringify(line));
}

const grokLines = [
  grokUpdate(
    GROK_SESSION,
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
    "u-1",
    AT,
  ),
  grokUpdate(
    GROK_SESSION,
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
      _meta: { modelId: "grok-4.7" },
    },
    "a-1",
    AT + 1,
  ),
  grokUpdate(GROK_SESSION, { sessionUpdate: "tool_call", toolCallId: "call-1" }, "t-1", AT + 2),
  grokUpdate(
    GROK_SESSION,
    { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
    "t-2",
    AT + 3,
  ),
];

const PARSED: Record<string, ParsedChunk> = {
  claude: parseClaudeChunk(jsonLines(claudeTranscriptLines("s-1")), 1),
  codex: parseCodexChunk(jsonLines(codexRolloutLines(THREAD, { withIds: true })), 1, {
    id: THREAD,
    state: { model: null, turnId: null },
  }),
  pi: parsePiChunk(jsonLines(piSessionLines()), 1),
  grok: parseGrokChunk(jsonLines(grokLines), 1),
};

describe("a parsed record", () => {
  for (const [tool, parsed] of Object.entries(PARSED)) {
    test(`from ${tool} has every field, an empty one as null`, () => {
      expect(ParsedChunk.safeParse(parsed).error?.issues ?? []).toEqual([]);
    });
  }
});
