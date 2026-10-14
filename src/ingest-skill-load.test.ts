import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BARE_SKILL_NAME_SQL, bareSkillName, parseSkillBody, preloadOf } from "./ingest-skill-load";

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
      install: "41c40cc68eb7",
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

  test("reads no install from a skill outside the plugin cache", () => {
    expect(
      parseSkillBody(`Base directory for this skill: /Users/x/.claude/skills/build\n\n# Build`)?.install,
    ).toBeNull();
    expect(
      parseSkillBody(`Base directory for this skill: /Users/x/code/kit/skills/build\n\n# Build`)?.install,
    ).toBeNull();
  });
});

describe("naming a skill", () => {
  test("drops the plugin a name is qualified by", () => {
    expect(bareSkillName("cniska-skills:coordinate")).toBe("coordinate");
    expect(bareSkillName("coordinate")).toBe("coordinate");
  });

  test("drops it the same way in SQL", () => {
    const db = new Database(":memory:");
    try {
      const bare = (name: string) =>
        db
          .query<{ bare: string }, [string]>(
            `SELECT ${BARE_SKILL_NAME_SQL} AS bare FROM (SELECT ? AS skill_name)`,
          )
          .get(name)?.bare;
      expect(bare("cniska-skills:coordinate")).toBe("coordinate");
      expect(bare("coordinate")).toBe("coordinate");
    } finally {
      db.close();
    }
  });
});

describe("reading an agent's preloaded skill", () => {
  const command =
    "<command-message>acme:plan</command-message>\n<command-name>acme:plan</command-name>\n<skill-format>true</skill-format>";
  const body =
    "Base directory for this skill: /Users/x/.claude/plugins/cache/m/acme/0815d96b8b74-5e689e2b/skills/plan\n\n# Plan\n";

  test("names the skill from the command and hashes the body after it", () => {
    expect(preloadOf([command, body])).toEqual({
      name: "plan",
      skillPath: "/Users/x/.claude/plugins/cache/m/acme/0815d96b8b74-5e689e2b/skills/plan",
      bodyChars: 6,
      bodySha256: sha256("# Plan"),
      install: "0815d96b8b74-5e689e2b",
    });
  });

  test("reads none from a body alone, a command alone, or a command without a body", () => {
    expect(preloadOf([body])).toBeNull();
    expect(preloadOf([command])).toBeNull();
    expect(preloadOf([command, "# Plan"])).toBeNull();
  });
});
