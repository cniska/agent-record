import { z } from "zod";

const idOf = <Brand extends string>() => z.string().min(1).brand<Brand>();

export const SessionId = idOf<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export function sessionIdOf(text: string): SessionId | null {
  return SessionId.safeParse(text).data ?? null;
}

export const MessageId = idOf<"MessageId">();
export type MessageId = z.infer<typeof MessageId>;

export const ToolCallId = idOf<"ToolCallId">();
export type ToolCallId = z.infer<typeof ToolCallId>;

export const TurnId = idOf<"TurnId">();
export type TurnId = z.infer<typeof TurnId>;

export const ResponseId = idOf<"ResponseId">();
export type ResponseId = z.infer<typeof ResponseId>;
