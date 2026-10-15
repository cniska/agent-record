import { createHash } from "node:crypto";
import { z } from "zod";
import { MessageId, ToolCallId } from "./ingest-ids";
import { Timestamp } from "./timestamp";

export const HOWS = ["model", "user", "read", "preload"] as const;

const SkillBodyFields = z.strictObject({
  bodyChars: z.number(),
  bodySha256: z.string(),
  skillPath: z.string(),
  install: z.string().nullable(),
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
      how: z.enum(HOWS).extract(["model", "read"]),
    })
    .readonly(),
  SkillBodyFields.extend({ kind: z.literal("called-body"), toolCallId: ToolCallId }).readonly(),
  SkillBodyFields.extend({
    kind: z.literal("typed-body"),
    parentUuid: MessageId,
    skillName: z.string(),
  }).readonly(),
  SkillBodyFields.extend({
    kind: z.literal("preload"),
    messageId: MessageId,
    ts: Timestamp,
    skillName: z.string(),
  }).readonly(),
]);
export type SkillLoadRow = z.infer<typeof SkillLoadRow>;

const BODY_PREFIX = "Base directory for this skill:";
const COMMAND_NAME = /<command-name>\/?([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)<\/command-name>/i;
const SKILL_FILE = /(?:^|[\s"'/])skills\/(?:[^\s"'/]+\/)*([a-z0-9][a-z0-9-]*)\/SKILL\.md/i;

const PLUGIN_INSTALL = /\/plugins\/cache\/[^/]+\/[^/]+\/([^/]+)\/skills\/[^/]+\/?$/;
const QUALIFIER = ":";

const APPENDED_ARGUMENTS = "\n\nARGUMENTS: ";
const EDGE_NEWLINES = /^\n+|\n+$/g;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function withoutAppendedArguments(body: string): string {
  const at = body.lastIndexOf(APPENDED_ARGUMENTS);
  return at === -1 ? body : body.slice(0, at);
}

export const bareSkillName = (name: string): string => name.slice(name.indexOf(QUALIFIER) + 1);

type ParsedBody = { readonly name: string } & SkillBodyFields;

export type SkillBody = { readonly kind: "preload" | "injected" } & ParsedBody;

function parseSkillBody(text: string): ParsedBody | null {
  if (!text.startsWith(BODY_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const path = text.slice(BODY_PREFIX.length, newline === -1 ? undefined : newline).trim();
  if (path.length === 0) return null;
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return null;
  const body =
    newline === -1 ? "" : withoutAppendedArguments(text.slice(newline + 1)).replace(EDGE_NEWLINES, "");
  const install = PLUGIN_INSTALL.exec(path)?.[1] ?? null;
  return { name, skillPath: path, bodyChars: body.length, bodySha256: sha256(body), install };
}

export function skillBodyOf(texts: readonly string[]): SkillBody | null {
  const [command, text] = texts;
  const preload = command !== undefined && text !== undefined && skillFromCommand(command) !== null;
  const body = preload ? parseSkillBody(text) : null;
  if (body !== null) return { kind: "preload", ...body };
  const injected = parseSkillBody(texts.join("\n"));
  return injected === null ? null : { kind: "injected", ...injected };
}

export function skillFromCommand(text: string): string | null {
  return COMMAND_NAME.exec(text)?.[1] ?? null;
}

export function skillFromFileRead(text: string): string | null {
  return SKILL_FILE.exec(text)?.[1] ?? null;
}
