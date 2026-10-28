import { z } from "zod";

const nonEmptyId = () => z.string().min(1);

export const SessionId = nonEmptyId().brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

const SUBAGENT_OF = "@";

export const TopLevelSessionId = SessionId.refine((id) => !id.includes(SUBAGENT_OF), {
  error: `a top-level session id holds no ${SUBAGENT_OF}, which marks a subagent's`,
});

export function sessionIdOf(text: string): SessionId | null {
  return TopLevelSessionId.safeParse(text).data ?? null;
}

export function subagentSessionId(agentId: string, topLevel: SessionId): SessionId {
  return SessionId.parse(`${agentId}${SUBAGENT_OF}${topLevel}`);
}

const SUBAGENT_FILE = "agent-";

export function agentIdOfFileName(name: string): string | null {
  return name.startsWith(SUBAGENT_FILE) ? name.slice(SUBAGENT_FILE.length) : null;
}

export function subagentSessionIdSql(agentColumn: string, topLevelColumn: string): string {
  return `${agentColumn} || '${SUBAGENT_OF}' || ${topLevelColumn}`;
}

export function subagentSessionSql(column: string): string {
  return `instr(${column}, '${SUBAGENT_OF}') > 0`;
}

export function topLevelSessionSql(column: string): string {
  const at = `instr(${column}, '${SUBAGENT_OF}')`;
  return `CASE WHEN ${at} = 0 THEN ${column} ELSE substr(${column}, ${at} + 1) END`;
}

export const MessageId = nonEmptyId().brand<"MessageId">();
export type MessageId = z.infer<typeof MessageId>;

export const ToolCallId = nonEmptyId().brand<"ToolCallId">();
export type ToolCallId = z.infer<typeof ToolCallId>;

export const TurnId = nonEmptyId().brand<"TurnId">();
export type TurnId = z.infer<typeof TurnId>;

export const ResponseId = nonEmptyId().brand<"ResponseId">();
export type ResponseId = z.infer<typeof ResponseId>;
