import { errorTextOf } from "./ingest-error-text";
import { maskSecrets } from "./ingest-secrets";
import type { ParsedChunk, ToolCallRow } from "./ingest-session-records";

const masked = (text: string | null): string | null => (text === null ? null : maskSecrets(text));

function maskedToolCall(row: ToolCallRow): ToolCallRow {
  if (row.kind === "result")
    return { ...row, errorText: row.errorText === null ? null : errorTextOf(row.errorText) };
  return { ...row, command: masked(row.command), filePath: masked(row.filePath) };
}

export function maskedChunk(chunk: ParsedChunk): ParsedChunk {
  return {
    ...chunk,
    session: chunk.session.map((facts) => ({ ...facts, title: masked(facts.title) })),
    messages: chunk.messages.map((message) => ({
      ...message,
      slashCommand: masked(message.slashCommand),
      denial:
        message.denial === null
          ? null
          : {
              ...message.denial,
              userFeedback: masked(message.denial.userFeedback),
              reason: masked(message.denial.reason),
            },
      text: masked(message.text),
      extra: masked(message.extra),
    })),
    toolCalls: chunk.toolCalls.map(maskedToolCall),
  };
}
