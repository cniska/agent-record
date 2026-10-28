import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const GUARDED_DIRS = ["src", "acceptance", "plugin", "scripts", "npm", "docs"];

const SELF = "scripts/standalone.test.ts";

const WORKFLOWS = ".github/workflows";

const INSTALLED_WORKFLOW = "# agent-gate:";

const README = "README.md";

const GUARDED_FILES = ["SPEC.md", README];

const CONTRIBUTOR_DOC = "docs/development.md";

const SUGGESTED = /^(cniska-skills|agent-skills)$/;

const CROSSLINK_HEADING = "## Related";

const NEXT_SECTION = "## ";

const CROSSLINK = /\[(agent-(skills|task|record|gates|worktree))\]\(https:\/\/github\.com\/cniska\/\1\)/g;

type Naming = { readonly names: string; readonly pattern: RegExp; readonly crosslinked: boolean };

const NAMINGS: readonly Naming[] = [
  {
    names: "another tool",
    pattern: /\b(cniska-(skills|task|gates|worktree)|agent-(task|gates|worktree|skills))\b/g,
    crosslinked: true,
  },
  { names: "a skill path", pattern: /skills\/(workflow|expertise)\/|task\/references/g, crosslinked: false },
  { names: "a skill, agent or role", pattern: /coordinate|reviewer|coach|researcher/gi, crosslinked: false },
  { names: "a report shape", pattern: /\b(Fix|Consider|Tier)\b/g, crosslinked: false },
  { names: "a skill", pattern: /skill[^\n]*"task"|"task"[^\n]*skill/gi, crosslinked: false },
];

type Guarded = { readonly path: string; readonly text: string };

function crosslinkSection(lines: readonly string[]): ReadonlySet<number> {
  const heading = lines.indexOf(CROSSLINK_HEADING);
  if (heading === -1) return new Set();
  const next = lines.findIndex((line, index) => index > heading && line.startsWith(NEXT_SECTION));
  const end = next === -1 ? lines.length : next;
  return new Set(Array.from({ length: end - heading - 1 }, (_, offset) => heading + 1 + offset));
}

function inCrosslink(line: string, at: number): boolean {
  return [...line.matchAll(CROSSLINK)].some(
    ({ 0: link, index: start }) => at >= start && at < start + link.length,
  );
}

function namings({ path, text }: Guarded): readonly string[] {
  const suggesting = path === CONTRIBUTOR_DOC;
  const lines = text.split("\n");
  const section = path === README ? crosslinkSection(lines) : new Set<number>();
  return lines.flatMap((line, index) => {
    const at = index + 1;
    return NAMINGS.flatMap(({ names, pattern, crosslinked }) =>
      [...line.matchAll(pattern)]
        .filter(([match]) => !(suggesting && SUGGESTED.test(match)))
        .filter(({ index: start }) => !(crosslinked && section.has(index) && inCrosslink(line, start)))
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
  return [...paths.map(read), ...filesUnder(WORKFLOWS).map(read).filter(ownWorkflow)].toSorted((a, b) =>
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

  test("lets only the README's Related section link the other tools, each by its own name", () => {
    const link = "[agent-gates](https://github.com/cniska/agent-gates)";
    const text = [
      `See ${link} and agent-task.`,
      "## Related",
      `Add-on to [agent-skills](https://github.com/cniska/agent-skills), beside ${link} and [agent-task](https://github.com/cniska/agent-task).`,
      "Install cniska-task, or [agent-worktree](https://github.com/cniska/agent-gates), or [reviewer](https://github.com/cniska/agent-record).",
      "## Next",
      link,
      "## Related",
      link,
    ].join("\n");
    expect(namings({ path: "README.md", text })).toEqual([
      "README.md:1 names another tool: agent-gates",
      "README.md:1 names another tool: agent-gates",
      "README.md:1 names another tool: agent-task",
      "README.md:4 names another tool: cniska-task",
      "README.md:4 names another tool: agent-worktree",
      "README.md:4 names another tool: agent-gates",
      "README.md:4 names a skill, agent or role: reviewer",
      "README.md:6 names another tool: agent-gates",
      "README.md:6 names another tool: agent-gates",
      "README.md:8 names another tool: agent-gates",
      "README.md:8 names another tool: agent-gates",
    ]);
    expect(namings({ path: "docs/commands.md", text: `## Related\n${link}` })).toEqual([
      "docs/commands.md:2 names another tool: agent-gates",
      "docs/commands.md:2 names another tool: agent-gates",
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
    expect(paths).toContain("scripts/smoke.sh");
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).toContain(".github/workflows/check.yml");
    expect(paths).not.toContain(SELF);
    expect(ownWorkflow({ path: "x.yml", text: "# agent-gate:made-up:1\nname: X\n" })).toBe(false);
    expect(ownWorkflow({ path: "x.yml", text: "name: X\n# agent-gate:made-up:1\n" })).toBe(true);
  });
});
