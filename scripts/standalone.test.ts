import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const GUARDED_DIRS = ["src", "acceptance", "plugin"];

const GUARDED_FILES = ["SPEC.md", "README.md"];

const README = "README.md";

const CONTRIBUTOR_SECTION = "## Development";

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

function contributorLines(text: string): ReadonlySet<number> {
  const lines = text.split("\n");
  const start = lines.indexOf(CONTRIBUTOR_SECTION);
  if (start === -1) return new Set();
  const after = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const end = after === -1 ? lines.length : after;
  return new Set(Array.from({ length: end - start }, (_, offset) => start + offset + 1));
}

function namings({ path, text }: Guarded): readonly string[] {
  const suggesting = path === README ? contributorLines(text) : new Set<number>();
  return text.split("\n").flatMap((line, index) => {
    const at = index + 1;
    return NAMINGS.flatMap(({ names, pattern }) =>
      [...line.matchAll(pattern)]
        .filter(([match]) => !(suggesting.has(at) && SUGGESTED.test(match)))
        .map(([match]) => `${path}:${at} names ${names}: ${match}`),
    );
  });
}

function guardedFiles(): readonly Guarded[] {
  const paths = [
    ...GUARDED_DIRS.flatMap((dir) =>
      [...new Bun.Glob("**/*").scanSync({ cwd: join(ROOT, dir), dot: true })].map((path) => join(dir, path)),
    ),
    ...GUARDED_FILES,
  ];
  return paths.sort().map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

describe("the repo stands alone", () => {
  test("names no other tool, skill, agent, plugin install or report shape", () => {
    expect(guardedFiles().flatMap(namings)).toEqual([]);
  });

  test("lets only the README's contributor section suggest cniska-skills", () => {
    const text = `# x\n\nUse cniska-skills.\n\n${CONTRIBUTOR_SECTION}\n\nTry cniska-skills or agent-gates.\n\n## Next\n\ncniska-skills`;
    expect(namings({ path: README, text })).toEqual([
      "README.md:3 names another tool: cniska-skills",
      "README.md:7 names another tool: agent-gates",
      "README.md:11 names another tool: cniska-skills",
    ]);
    expect(namings({ path: "SPEC.md", text })).toHaveLength(4);
  });

  test("names a skill's task only where a skill is named, and the report words only as they are capitalised", () => {
    const text =
      'kind: "task"\nWORKER_SKILL = "task"\nfix: a bug\n## Fix\nan agent-record plugin, cniska-record';
    expect(namings({ path: "src/x.ts", text })).toEqual([
      'src/x.ts:2 names a skill: SKILL = "task"',
      "src/x.ts:4 names a report shape: Fix",
    ]);
  });
});
