import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bareSkillName, type SkillBody, skillBodyOf } from "./ingest-skill-load";

const SKILL_FILE_BODY = "# Deploy\n\nRun the work.\n\n## Red flags\n\n- A stalled agent";

const injectedBody = (text: string) => skillBodyOf([text]);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const injected = (tail: string) =>
  `Base directory for this skill: /Users/x/.claude/plugins/cache/acme/kit/41c40cc68eb7/skills/deploy\n\n${SKILL_FILE_BODY}${tail}`;

describe("parsing an injected skill body", () => {
  test("hashes the body as the skill's file holds it, whatever the caller passed", () => {
    const expected: SkillBody = {
      kind: "injected",
      name: "deploy",
      skillPath: "/Users/x/.claude/plugins/cache/acme/kit/41c40cc68eb7/skills/deploy",
      bodyChars: SKILL_FILE_BODY.length,
      bodySha256: sha256(SKILL_FILE_BODY),
      install: "41c40cc68eb7",
    };
    expect(injectedBody(injected("\n"))).toEqual(expected);
    expect(injectedBody(injected(""))).toEqual(expected);
    expect(injectedBody(injected("\n\n\nARGUMENTS: resume the task in this project"))).toEqual(expected);
    expect(injectedBody(injected("\n\nARGUMENTS: feature route:\nslice 4, then push\n"))).toEqual(expected);
  });

  test("keeps an ARGUMENTS line the skill's own body holds above the appended one", () => {
    const own = `${SKILL_FILE_BODY}\n\nARGUMENTS: in the skill itself\n\n## More`;
    const text = `Base directory for this skill: /s/kit\n\n${own}\n\nARGUMENTS: what the caller passed`;
    expect(injectedBody(text)?.bodySha256).toBe(sha256(own));
  });

  test("reads no body from text that is not one", () => {
    expect(injectedBody("# Deploy")).toBeNull();
    expect(injectedBody("Base directory for this skill: \n\n# Body")).toBeNull();
  });

  test("reads no install from a skill outside the plugin cache", () => {
    expect(
      injectedBody(`Base directory for this skill: /Users/x/.claude/skills/build\n\n# Build`)?.install,
    ).toBeNull();
    expect(
      injectedBody(`Base directory for this skill: /Users/x/code/kit/skills/build\n\n# Build`)?.install,
    ).toBeNull();
  });
});

describe("naming a skill", () => {
  test("drops the plugin a name is qualified by", () => {
    expect(bareSkillName("acme:deploy")).toBe("deploy");
    expect(bareSkillName("deploy")).toBe("deploy");
  });
});

describe("reading an agent's preloaded skill", () => {
  const command =
    "<command-message>acme:plan</command-message>\n<command-name>acme:plan</command-name>\n<skill-format>true</skill-format>";
  const body =
    "Base directory for this skill: /Users/x/.claude/plugins/cache/m/acme/0815d96b8b74-5e689e2b/skills/plan\n\n# Plan\n";

  test("hashes the body that follows the command", () => {
    expect(skillBodyOf([command, body])).toEqual({
      kind: "preload",
      name: "plan",
      skillPath: "/Users/x/.claude/plugins/cache/m/acme/0815d96b8b74-5e689e2b/skills/plan",
      bodyChars: 6,
      bodySha256: sha256("# Plan"),
      install: "0815d96b8b74-5e689e2b",
    });
  });

  test("names the skill by its directory, as every other load with a body", () => {
    expect(skillBodyOf([command.replaceAll("acme:plan", "acme:other"), body])?.name).toBe("plan");
  });

  test("reads a body alone as injected, and none from a command alone or a command without a body", () => {
    expect(skillBodyOf([body])?.kind).toBe("injected");
    expect(skillBodyOf([command])).toBeNull();
    expect(skillBodyOf([command, "# Plan"])).toBeNull();
  });
});
