import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const GUARDED_DIRS = ["src", "acceptance", "plugin", "scripts", "npm", "docs"];

const SELF = "scripts/standalone.test.ts";

const WORKFLOWS = ".github/workflows";

const INSTALLED_WORKFLOW = "# agent-gate:";

const GUARDED_FILES = ["SPEC.md", "README.md"];

const CONTRIBUTOR_DOC = "docs/development.md";

const SUGGESTED = /^(cniska-skills|agent-skills)$/;

type Naming = { readonly names: string; readonly pattern: RegExp };

const NAMINGS: readonly Naming[] = [
  { names: "another tool", pattern: /\b(cniska-(skills|gates|worktree)|agent-(gates|worktree|skills))\b/g },
  { names: "a skill path", pattern: /skills\/(workflow|expertise)\/|task\/references/g },
  { names: "a skill, agent or role", pattern: /coordinate|reviewer|coach|researcher/gi },
  { names: "a report shape", pattern: /\b(Fix|Consider|Tier)\b/g },
  { names: "a skill", pattern: /skill[^\n]*"task"|"task"[^\n]*skill/gi },
];

type Guarded = { readonly path: string; readonly text: string };

function namings({ path, text }: Guarded): readonly string[] {
  const suggesting = path === CONTRIBUTOR_DOC;
  return text.split("\n").flatMap((line, index) => {
    const at = index + 1;
    return NAMINGS.flatMap(({ names, pattern }) =>
      [...line.matchAll(pattern)]
        .filter(([match]) => !(suggesting && SUGGESTED.test(match)))
        .map(([match]) => `${path}:${at} names ${names}: ${match}`),
    );
  });
}

function filesUnder(dir: string): readonly string[] {
  return [...new Bun.Glob("**/*").scanSync({ cwd: join(ROOT, dir), dot: true })].map((path) =>
    join(dir, path),
  );
}

function ownWorkflow({ text }: Guarded): boolean {
  return !text.startsWith(INSTALLED_WORKFLOW);
}

function read(path: string): Guarded {
  return { path, text: readFileSync(join(ROOT, path), "utf8") };
}

function guardedFiles(): readonly Guarded[] {
  const paths = [...GUARDED_DIRS.flatMap(filesUnder), ...GUARDED_FILES].filter((path) => path !== SELF);
  return [...paths.map(read), ...filesUnder(WORKFLOWS).map(read).filter(ownWorkflow)].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

describe("the repo stands alone", () => {
  test("names no other tool, skill, agent, plugin install or report shape", () => {
    expect(guardedFiles().flatMap(namings)).toEqual([]);
  });

  test("lets only docs/development.md suggest cniska-skills", () => {
    const text = "# x\n\nTry cniska-skills or agent-gates.";
    expect(namings({ path: "docs/development.md", text })).toEqual([
      "docs/development.md:3 names another tool: agent-gates",
    ]);
    expect(namings({ path: "README.md", text })).toEqual([
      "README.md:3 names another tool: cniska-skills",
      "README.md:3 names another tool: agent-gates",
    ]);
  });

  test("names a skill's task only where a skill is named, and the report words only as they are capitalised", () => {
    const text =
      'kind: "task"\nWORKER_SKILL = "task"\nfix: a bug\n## Fix\nan agent-record plugin, cniska-record';
    expect(namings({ path: "src/x.ts", text })).toEqual([
      'src/x.ts:2 names a skill: SKILL = "task"',
      "src/x.ts:4 names a report shape: Fix",
    ]);
  });

  test("guards the release paths and the workflows it owns, but not itself or a workflow another tool installs", () => {
    const paths = guardedFiles().map(({ path }) => path);
    expect(paths).toContain("npm/agent-record");
    expect(paths).toContain("docs/releasing.md");
    expect(paths).toContain("scripts/install.sh");
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).toContain(".github/workflows/check.yml");
    expect(paths).not.toContain(SELF);
    expect(ownWorkflow({ path: "x.yml", text: "# agent-gate:made-up:1\nname: X\n" })).toBe(false);
    expect(ownWorkflow({ path: "x.yml", text: "name: X\n# agent-gate:made-up:1\n" })).toBe(true);
  });
});
