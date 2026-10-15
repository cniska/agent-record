import { describe, expect, test } from "bun:test";
import { claudeTranscriptLines, withFields, withoutTimestamp } from "./fixtures.test-support";
import { parseClaudeChunk } from "./ingest-parse-claude";

const lines = claudeTranscriptLines("s-1").map((l) => JSON.stringify(l));
const parsed = parseClaudeChunk(lines, 1);

describe("parseClaudeChunk", () => {
  test("writes one usage row per content-block line so the ingester can dedupe on message id", () => {
    expect(parsed.usage.filter((u) => u.responseId === "msg-1")).toHaveLength(2);
    expect(new Set(parsed.usage.map((u) => u.responseId)).size).toBe(1);
  });

  test("keeps thinking blocks out of the message text", () => {
    const text = parsed.messages
      .filter((m) => m.id === "msg-1")
      .map((m) => m.text)
      .join("\n");
    expect(text).toContain("First half.");
    expect(text).toContain("Second half.");
    expect(text).not.toContain("SECRET REASONING");
  });

  test("keeps tool results out of the message text", () => {
    const toolResult = parsed.messages.find((m) => m.id === "u-2");
    expect(toolResult).toBeDefined();
    expect(toolResult?.text).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("SECRET FILE CONTENTS");
  });

  test("maps the token fields Claude reports, with input excluding cached reads", () => {
    const u = parsed.usage.at(-1);
    expect(u).toMatchObject({
      inputTokens: 5,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      outputTokens: 50,
      attributionSkill: "build",
      model: "claude-opus-5",
    });
  });

  test("reports each line's own usage, partial figures included", () => {
    expect(parsed.usage.map((u) => u.outputTokens)).toEqual([9, 50]);
  });

  test("marks an injected skill body", () => {
    const body = parsed.messages.find((m) => m.id === "u-3");
    expect(body?.isMeta).toBe(true);
    expect(body?.isSkillBody).toBe(true);
    expect(parsed.messages.find((m) => m.id === "u-1")?.isSkillBody).toBe(false);
  });

  test("records the ways a user overrode the agent", () => {
    const overridden = parsed.messages.find((m) => m.id === "u-4");
    expect(overridden).toMatchObject({
      denial: { kind: "user-rejected", userFeedback: "no, not like that", reason: null },
    });
    expect(JSON.parse(overridden?.extra ?? "{}")).toMatchObject({ interruptedMessageId: "msg-1" });
  });

  test("keeps the reason a denial returned in place of the tool's result", () => {
    const hookText = "PreToolUse:Bash hook error: Push blocked: run the made-up check first.";
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "user",
          uuid: "u-hook",
          timestamp: "2026-09-16T10:04:00.000Z",
          toolDenialKind: "permission-rule",
          toolUseResult: `Error: ${hookText}`,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-hook", is_error: true, content: hookText }],
          },
        }),
      ],
      1,
    );
    expect(chunk.messages).toMatchObject([
      { id: "u-hook", denial: { kind: "permission-rule", userFeedback: null, reason: hookText } },
    ]);
    expect(parsed.messages.find((m) => m.id === "u-1")?.denial).toBeNull();
  });

  test("numbers src_line from the file, not the chunk", () => {
    expect(parsed.messages.find((m) => m.id === "u-1")?.srcLine).toBe(2);
    const later = parseClaudeChunk(lines.slice(1), 2);
    expect(later.messages.find((m) => m.id === "u-1")?.srcLine).toBe(2);
  });

  test("carries prompt provenance and the skill a turn ran under", () => {
    expect(parsed.messages.find((m) => m.id === "u-1")).toMatchObject({
      promptSource: "typed",
      originKind: "human",
      turnId: "p-1",
    });
    expect(parsed.messages.find((m) => m.id === "msg-1")?.attributionSkill).toBe("build");
  });

  test("takes the session's last time from its latest timestamped line, whatever its type", () => {
    const times = parsed.session.flatMap(({ ts }) => (ts ? [ts] : []));
    expect(times.sort().at(-1)).toBe<string>("2026-09-16T10:08:00.000Z");
  });

  test("takes the session title from an ai-title line", () => {
    expect(parsed.session.some((s) => s.title === "Add the parser")).toBe(true);
  });

  test("names the line number of a complete line that is not JSON", () => {
    const corrupt = parseClaudeChunk([...lines.slice(0, 1), "{not json", ...lines.slice(1, 2)], 10);
    expect(corrupt.dropped).toEqual([11]);
    expect(corrupt.messages.length).toBeGreaterThan(0);
  });

  test("drops a line whose read field has the wrong type, and writes no row from it", () => {
    const stamp = "2026-09-16T10:03:00.000Z";
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "assistant",
          uuid: "a-1",
          timestamp: stamp,
          message: { id: "msg-x", usage: { output_tokens: "12" } },
        }),
        JSON.stringify({
          type: "system",
          subtype: "turn_duration",
          uuid: "t-1",
          timestamp: stamp,
          durationMs: "x",
        }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([1, 2]);
    expect(chunk.usage).toEqual([]);
    expect(chunk.turns).toEqual([]);
  });

  describe("a message queued while a turn runs", () => {
    const stamp = "2026-09-16T10:03:00.000Z";
    const queued = (uuid: string, attachment: Record<string, unknown>) =>
      JSON.stringify({
        type: "attachment",
        uuid,
        parentUuid: "a-1",
        timestamp: stamp,
        cwd: "/Users/x/code/demo",
        isSidechain: false,
        attachment: { type: "queued_command", commandMode: "prompt", timestamp: stamp, ...attachment },
      });
    const chunk = parseClaudeChunk(
      [
        queued("q-1", {
          prompt: "commit msgs should be lowercase",
          origin: { kind: "human" },
          source_uuid: "c-1",
        }),
        queued("q-2", {
          prompt: [
            { type: "text", text: "see this" },
            { type: "image", source: { type: "base64", data: "AAAA" } },
          ],
          origin: { kind: "human" },
        }),
        queued("q-3", {
          prompt: "<task-notification>done</task-notification>",
          commandMode: "task-notification",
        }),
        queued("q-4", { prompt: "from a peer", origin: { kind: "peer" }, isMeta: true }),
        queued("q-5", { prompt: "<ci-monitor-event>watching</ci-monitor-event>" }),
        JSON.stringify({
          type: "attachment",
          uuid: "q-6",
          timestamp: stamp,
          attachment: { type: "todo_reminder" },
        }),
      ],
      7,
    );

    test("is recorded as a message the owner typed, at the line's time", () => {
      expect(chunk.dropped).toEqual([]);
      expect(chunk.messages.find((m) => m.id === "q-1")).toMatchObject({
        ts: "2026-09-16T10:03:00.000Z",
        role: "user",
        originKind: "human",
        promptSource: "mid_turn",
        isMeta: false,
        text: "commit msgs should be lowercase",
        srcLine: 7,
      });
    });

    test("keeps the text of a queued message that carries an image", () => {
      expect(chunk.messages.find((m) => m.id === "q-2")?.text).toBe("see this");
    });

    test("leaves out what the harness or another agent queued", () => {
      expect(chunk.messages.map((m) => m.id)).toEqual<string[]>(["q-1", "q-2"]);
    });
  });

  test("keeps a user line whose toolUseResult is an array", () => {
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "user",
          uuid: "u-10",
          timestamp: "2026-09-16T10:03:00.000Z",
          message: { content: [{ type: "tool_result", tool_use_id: "tu-10", content: "ok" }] },
          toolUseResult: [{ type: "text", text: "ok" }],
        }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([]);
    expect(chunk.toolCalls).toMatchObject([{ id: "tu-10", resultBytes: 2 }]);
  });

  test("keeps a user line whose toolUseResult is a bare string", () => {
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "user",
          uuid: "u-9",
          timestamp: "2026-09-16T10:03:00.000Z",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tu-9", content: "boom", is_error: true }],
          },
          toolUseResult: "Error: boom",
        }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([]);
    expect(chunk.toolCalls).toMatchObject([{ id: "tu-9", isError: true, resultBytes: 4 }]);
  });

  test("keeps a line whose nullable fields and content blocks are null", () => {
    const stamp = "2026-09-16T10:03:00.000Z";
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "assistant",
          uuid: "a-2",
          timestamp: stamp,
          attributionSkill: null,
          message: {
            id: "msg-n",
            usage: null,
            content: [
              null,
              { type: "text", text: "hi" },
              { type: "tool_use", id: "tu-n", name: "Bash", input: null },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u-n",
          timestamp: stamp,
          isMeta: null,
          parentUuid: null,
          sourceToolUseID: null,
          interruptedMessageId: null,
          toolDenialKind: null,
          message: { content: "hello" },
        }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([]);
    expect(chunk.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
    expect(chunk.toolCalls).toMatchObject([{ id: "tu-n", toolName: "Bash" }]);
  });

  test("keeps a subagent's hand-back report as its message text", () => {
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "assistant",
          uuid: "a-h",
          timestamp: "2026-09-16T10:03:00.000Z",
          message: {
            id: "msg-h",
            content: [
              { type: "text", text: "Done." },
              {
                type: "tool_use",
                id: "tu-h",
                name: "SubagentHandback",
                input: { message: "No findings.\nVerdict: accept" },
              },
              { type: "tool_use", id: "tu-b", name: "Bash", input: { message: "not a report" } },
            ],
          },
        }),
      ],
      1,
    );
    expect(chunk.messages.map((m) => m.text)).toEqual(["Done.\nNo findings.\nVerdict: accept"]);
    expect(chunk.toolCalls).toMatchObject([{ id: "tu-h", toolName: "SubagentHandback" }, { id: "tu-b" }]);
  });

  test("ties a skill file the Read tool read to that call, a skill nested in a folder of skills too", () => {
    const read = (id: string, path: string) => ({
      type: "tool_use",
      id,
      name: "Read",
      input: { file_path: path },
    });
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "assistant",
          uuid: "a-r",
          timestamp: "2026-09-16T10:03:00.000Z",
          message: {
            id: "msg-r",
            model: "claude-opus-5",
            content: [
              read("tu-1", "/x/kit/skills/team/review/SKILL.md"),
              read("tu-2", "/x/kit/skills/review/references/rules.md"),
              read("tu-3", "/x/notes/SKILL.md"),
            ],
          },
        }),
      ],
      1,
    );
    expect(chunk.skillLoads).toEqual<object[]>([
      {
        kind: "called",
        toolCallId: "tu-1",
        ts: "2026-09-16T10:03:00.000Z",
        model: "claude-opus-5",
        skillName: "review",
        how: "read",
      },
    ]);
  });

  test("marks a result Claude Code refused before the call ran, and not one whose call ran and errored", () => {
    const result = (id: string, content: unknown, isError: boolean) =>
      JSON.stringify({
        type: "user",
        uuid: `u-${id}`,
        timestamp: "2026-09-16T10:03:00.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
      });
    const chunk = parseClaudeChunk(
      [
        result("tu-1", "<tool_use_error>File has not been read yet.</tool_use_error>", true),
        result(
          "tu-2",
          [{ type: "text", text: "<tool_use_error>InputValidationError: bad</tool_use_error>" }],
          true,
        ),
        result("tu-3", "<tool_use_error>Error calling tool (mcp__acme__label): </tool_use_error>", true),
        result("tu-4", "Exit code 2\nboom", true),
        result("tu-5", "<tool_use_error>quoted in a file</tool_use_error>", false),
      ],
      1,
    );
    expect(
      chunk.toolCalls.map((call) => [call.id, call.kind === "result" ? call.hostRefused : "call"]),
    ).toEqual([
      ["tu-1", true],
      ["tu-2", true],
      ["tu-3", false],
      ["tu-4", false],
      ["tu-5", false],
    ]);
  });

  test("reads a failed command's exit code from the result Claude Code writes for it", () => {
    const result = (id: string, content: unknown, isError: boolean) =>
      JSON.stringify({
        type: "user",
        uuid: `u-${id}`,
        timestamp: "2026-09-16T10:03:00.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
      });
    const chunk = parseClaudeChunk(
      [
        result("tu-1", "Exit code 2\nboom", true),
        result("tu-2", [{ type: "text", text: "Exit code 137" }], true),
        result("tu-3", "PreToolUse:Bash hook error: denied", true),
        result("tu-4", "Exit code 3", false),
        result("tu-5", "error\nExit code 4", true),
      ],
      1,
    );
    expect(chunk.toolCalls.map((call) => [call.id, call.kind === "result" ? call.exitCode : "call"])).toEqual(
      [
        ["tu-1", 2],
        ["tu-2", 137],
        ["tu-3", null],
        ["tu-4", null],
        ["tu-5", null],
      ],
    );
  });

  test("keeps each compact boundary as a compaction, and no other system line", () => {
    const boundary = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      timestamp: "2026-09-16T10:30:00Z",
      compactMetadata: { trigger: "auto", preTokens: 767258 },
    });
    const other = JSON.stringify({ type: "system", subtype: "api_error", timestamp: "2026-09-16T10:31:00Z" });
    const chunk = parseClaudeChunk([other, boundary], 4);
    expect(chunk.compactions.map((c) => [c.ts, c.srcLine])).toEqual<unknown[]>([
      ["2026-09-16T10:30:00.000Z", 5],
    ]);
    expect(chunk.dropped).toEqual([]);
  });

  test("stores a time with an offset as UTC", () => {
    const [, first] = claudeTranscriptLines("s-1");
    const offset = withFields(first, { timestamp: "2026-09-16T12:01:00+02:00" });
    expect(parseClaudeChunk([offset], 1).messages.map((m) => m.ts)).toEqual<string[]>([
      "2026-09-16T10:01:00.000Z",
    ]);
  });

  test("drops a line whose time does not parse", () => {
    const [, first] = claudeTranscriptLines("s-1");
    const unparsable = withFields(first, { timestamp: "2026-02-30T10:00:00Z" });
    const chunk = parseClaudeChunk([unparsable], 7);
    expect(chunk.dropped).toEqual([7]);
    expect(chunk.messages).toEqual([]);
  });

  test("refuses a line whose rows need a timestamp it does not carry", () => {
    const source = claudeTranscriptLines("s-1");
    const untimed = (index: number) => withoutTimestamp(source[index]);
    const chunk = parseClaudeChunk(
      [...lines.slice(0, 1), untimed(1), untimed(2), ...lines.slice(3, 4), untimed(9)],
      1,
    );
    expect(chunk.dropped).toEqual([2, 3, 5]);
    expect(chunk.messages.map((m) => m.ts)).toEqual<string[]>(["2026-09-16T10:03:00.000Z"]);
    expect(chunk.usage.map((u) => u.ts)).toEqual<string[]>(["2026-09-16T10:03:00.000Z"]);
    expect(chunk.turns).toEqual([]);
  });

  test("keeps a line that writes no timed row, timestamp or not", () => {
    const titled = parseClaudeChunk([JSON.stringify({ type: "ai-title", aiTitle: "Untimed" })], 1);
    expect(titled.dropped).toEqual([]);
    expect(titled.session).toEqual([
      {
        ts: null,
        cwd: null,
        gitBranch: null,
        cliVersion: null,
        entrypoint: null,
        title: "Untimed",
      },
    ]);
  });

  test("reports nothing dropped for a chunk that parsed whole", () => {
    expect(parsed.dropped).toEqual([]);
  });

  test("drops a line whose id is empty", () => {
    const [, first] = claudeTranscriptLines("s-1");
    const unnamed = withFields(first, { uuid: "" });
    const chunk = parseClaudeChunk([unnamed], 9);
    expect(chunk.dropped).toEqual([9]);
    expect(chunk.messages).toEqual([]);
  });

  test("reports a line with a tool use or tool result that has no id as dropped", () => {
    const stamp = "2026-09-16T10:03:00.000Z";
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "assistant",
          uuid: "a-3",
          timestamp: stamp,
          message: { id: "msg-3", content: [{ type: "tool_use", name: "Bash", input: {} }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u-3",
          timestamp: stamp,
          message: { content: [{ type: "tool_result", content: "ok" }] },
        }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([1, 2]);
    expect(chunk.toolCalls).toEqual([]);
  });

  test("keeps a line whose empty id is one it does not record", () => {
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({
          type: "user",
          uuid: "u-4",
          timestamp: "2026-09-16T10:03:00.000Z",
          message: { id: "", content: "hello" },
        }),
        JSON.stringify({ type: "summary", uuid: "", leafUuid: "u-4" }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([]);
    expect(chunk.messages.map((m) => m.text)).toEqual(["hello"]);
  });

  test("keeps no cursor state", () => {
    expect(parsed.cursorState).toBeNull();
  });

  test("reports an assistant line with no message id, and a title line with an empty title, as dropped", () => {
    const stamp = "2026-09-16T10:04:00.000Z";
    const chunk = parseClaudeChunk(
      [
        JSON.stringify({ type: "assistant", uuid: "a-5", timestamp: stamp, message: { content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          uuid: "a-6",
          timestamp: stamp,
          message: { id: "", content: "hi" },
        }),
        JSON.stringify({ type: "ai-title", aiTitle: "" }),
        JSON.stringify({ type: "custom-title", customTitle: "" }),
      ],
      1,
    );
    expect(chunk.dropped).toEqual([1, 2, 3, 4]);
    expect(chunk.messages).toEqual([]);
    expect(chunk.session.map((facts) => facts.title)).not.toContain("");
  });
});
