import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseSkillBody } from "./ingest-skill-load";

const SKILL_FILE_BODY = "# Coordinate\n\nRun the work.\n\n## Red flags\n\n- A stalled agent";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const injected = (tail: string) =>
  `Base directory for this skill: /Users/x/.claude/plugins/cache/acme/kit/41c40cc68eb7/skills/coordinate\n\n${SKILL_FILE_BODY}${tail}`;

describe("parsing an injected skill body", () => {
  test("hashes the body as the skill's file holds it, whatever the caller passed", () => {
    const expected = {
      name: "coordinate",
      skillPath: "/Users/x/.claude/plugins/cache/acme/kit/41c40cc68eb7/skills/coordinate",
      bodyChars: SKILL_FILE_BODY.length,
      bodySha256: sha256(SKILL_FILE_BODY),
    };
    expect(parseSkillBody(injected("\n"))).toEqual(expected);
    expect(parseSkillBody(injected(""))).toEqual(expected);
    expect(parseSkillBody(injected("\n\n\nARGUMENTS: resume the task in this project"))).toEqual(expected);
    expect(parseSkillBody(injected("\n\nARGUMENTS: feature route:\nslice 4, then push\n"))).toEqual(expected);
  });

  test("keeps an ARGUMENTS line the skill's own body holds above the appended one", () => {
    const own = `${SKILL_FILE_BODY}\n\nARGUMENTS: in the skill itself\n\n## More`;
    const text = `Base directory for this skill: /s/kit\n\n${own}\n\nARGUMENTS: what the caller passed`;
    expect(parseSkillBody(text)?.bodySha256).toBe(sha256(own));
  });

  test("reads no body from text that is not one", () => {
    expect(parseSkillBody("# Coordinate")).toBeNull();
    expect(parseSkillBody("Base directory for this skill: \n\n# Body")).toBeNull();
  });
});
