import { createHash } from "node:crypto";
import { z } from "zod";
import { Timestamp } from "./timestamp";

export const HOWS = ["model", "user", "read"] as const;

export type How = (typeof HOWS)[number];

const SkillBodyFields = z.strictObject({
  bodyChars: z.number(),
  bodySha256: z.string(),
  skillPath: z.string(),
});
type SkillBodyFields = Readonly<z.infer<typeof SkillBodyFields>>;

export const SkillLoadRow = z.union([
  z
    .strictObject({
      toolCallId: z.string(),
      ts: Timestamp,
      model: z.string().nullable(),
      skillName: z.string(),
      how: z.enum(HOWS),
    })
    .readonly(),
  SkillBodyFields.extend({ toolUseId: z.string() }).readonly(),
  SkillBodyFields.extend({ parentUuid: z.string(), skillName: z.string() }).readonly(),
]);
export type SkillLoadRow = z.infer<typeof SkillLoadRow>;

const BODY_PREFIX = "Base directory for this skill:";
const COMMAND_NAME = /<command-name>\/?([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)<\/command-name>/i;
const SKILL_FILE = /(?:^|[\s"'/])skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/i;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseSkillBody(text: string): ({ readonly name: string } & SkillBodyFields) | null {
  if (!text.startsWith(BODY_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const path = text.slice(BODY_PREFIX.length, newline === -1 ? undefined : newline).trim();
  if (path.length === 0) return null;
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return null;
  const body = newline === -1 ? "" : text.slice(newline + 1).replace(/^\n+/, "");
  return { name, skillPath: path, bodyChars: body.length, bodySha256: sha256(body) };
}

export function skillFromCommand(text: string): string | null {
  return COMMAND_NAME.exec(text)?.[1] ?? null;
}

export function skillFromFileRead(command: string): string | null {
  return SKILL_FILE.exec(command)?.[1] ?? null;
}
