import { createHash } from "node:crypto";
import { z } from "zod";
import { MessageId, ToolCallId } from "./ingest-ids";
import { Timestamp } from "./timestamp";

export const HOWS = ["model", "user", "read"] as const;

export type How = (typeof HOWS)[number];

const SkillBodyFields = z.strictObject({
  bodyChars: z.number(),
  bodySha256: z.string(),
  skillPath: z.string(),
});
type SkillBodyFields = Readonly<z.infer<typeof SkillBodyFields>>;

export const SkillLoadRow = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("called"),
      toolCallId: ToolCallId,
      ts: Timestamp,
      model: z.string().nullable(),
      skillName: z.string(),
      how: z.enum(HOWS),
    })
    .readonly(),
  SkillBodyFields.extend({ kind: z.literal("called-body"), toolUseId: ToolCallId }).readonly(),
  SkillBodyFields.extend({
    kind: z.literal("typed-body"),
    parentUuid: MessageId,
    skillName: z.string(),
  }).readonly(),
]);
export type SkillLoadRow = z.infer<typeof SkillLoadRow>;

const BODY_PREFIX = "Base directory for this skill:";
const COMMAND_NAME = /<command-name>\/?([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)<\/command-name>/i;
const SKILL_FILE = /(?:^|[\s"'/])skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/i;

const APPENDED_ARGUMENTS = "\n\nARGUMENTS: ";
const EDGE_NEWLINES = /^\n+|\n+$/g;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function withoutAppendedArguments(body: string): string {
  const at = body.lastIndexOf(APPENDED_ARGUMENTS);
  return at === -1 ? body : body.slice(0, at);
}

export function parseSkillBody(text: string): ({ readonly name: string } & SkillBodyFields) | null {
  if (!text.startsWith(BODY_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const path = text.slice(BODY_PREFIX.length, newline === -1 ? undefined : newline).trim();
  if (path.length === 0) return null;
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return null;
  const body =
    newline === -1 ? "" : withoutAppendedArguments(text.slice(newline + 1)).replace(EDGE_NEWLINES, "");
  return { name, skillPath: path, bodyChars: body.length, bodySha256: sha256(body) };
}

export function skillFromCommand(text: string): string | null {
  return COMMAND_NAME.exec(text)?.[1] ?? null;
}

export function skillFromFileRead(command: string): string | null {
  return SKILL_FILE.exec(command)?.[1] ?? null;
}
