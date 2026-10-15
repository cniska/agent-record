import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "@babel/types";
import { nodesOf } from "./syntax.test-support";

const ROOT = join(import.meta.dir, "..");
const ACCEPTANCE = join(ROOT, "acceptance");

const UNCITED_FAMILIES = new Set(["AC", "C", "D"]);
const DEFINITION = /^- \*\*([A-Z]+-[^*]+)\*\* —/gm;
const CRITERION_LINE = /^- \*\*(AC-[^*]+)\*\* —.*?(?:\(([A-Z]+-\w+(?:, [A-Z]+-\w+)*)\))?$/gm;
const CITED_CRITERIA = /^((?:AC-\d+ )+)/;
const WHOLE = /^[A-Z]+-[1-9]\d*$/;

const captures = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

const familyOf = (id: string): string => id.split("-")[0] ?? id;

function numberingProblems(ids: readonly string[]): readonly string[] {
  const problems = ids
    .filter((id) => !WHOLE.test(id))
    .map((id) => `${id} is not a family and a whole number`);
  for (const family of new Set(ids.map(familyOf))) {
    const members = ids.filter((id) => familyOf(id) === family && WHOLE.test(id));
    const expected = members.map((_, index) => `${family}-${index + 1}`);
    if (members.join() !== expected.join())
      problems.push(`${family} is numbered ${members.join(", ")} instead of from 1 without gaps`);
  }
  return problems;
}

type Criterion = { readonly id: string; readonly cites: readonly string[] | null };

const criteriaOf = (spec: string): readonly Criterion[] =>
  [...spec.matchAll(CRITERION_LINE)].flatMap(([, id, cites]) =>
    id === undefined ? [] : [{ id, cites: cites?.split(", ") ?? null }],
  );

function criterionProblems(criteria: readonly Criterion[], ids: readonly string[]): readonly string[] {
  const cited = new Set(criteria.flatMap((criterion) => criterion.cites ?? []));
  return [
    ...criteria.filter((criterion) => criterion.cites === null).map(({ id }) => `${id} cites no requirement`),
    ...ids
      .filter((id) => !UNCITED_FAMILIES.has(familyOf(id)) && !cited.has(id))
      .map((id) => `${id} is cited by no criterion`),
  ];
}

function mentionProblems(
  spec: string,
  criteria: readonly Criterion[],
  ids: readonly string[],
): readonly string[] {
  const families = [...new Set(ids.map(familyOf))].join("|");
  const mention = new RegExp(`\\b((?:${families})-\\d+)\\b`, "g");
  const cited = criteria.flatMap((criterion) => criterion.cites ?? []);
  return [...new Set([...captures(spec, mention), ...cited])]
    .filter((id) => !ids.includes(id))
    .map((id) => `${id} is mentioned but not defined`);
}

type AcceptanceTest = { readonly name: string | null; readonly modifier: string | null };

function testProblems(criteria: readonly string[], tests: readonly AcceptanceTest[]): readonly string[] {
  const problems: string[] = [];
  const tested = new Set<string>();
  for (const { name, modifier } of tests) {
    if (name === null) {
      problems.push("an acceptance test's name is not a string literal");
      continue;
    }
    if (modifier !== null) {
      problems.push(`acceptance test "${name}" is a test.${modifier}, not a test that runs`);
      continue;
    }
    const proves = CITED_CRITERIA.exec(name)?.[1]?.trim().split(" ") ?? [];
    if (proves.length === 0) problems.push(`acceptance test "${name}" cites no criterion`);
    for (const criterion of proves) {
      tested.add(criterion);
      if (!criteria.includes(criterion))
        problems.push(`acceptance test "${name}" cites ${criterion}, which the spec does not define`);
    }
  }
  for (const criterion of criteria)
    if (!tested.has(criterion)) problems.push(`${criterion} has no acceptance test`);
  return problems;
}

const PLAIN_TEST = "test";

function testCalleeOf(callee: Node): { readonly modifier: string | null } | null {
  if (callee.type === "Identifier") return callee.name === PLAIN_TEST ? { modifier: null } : null;
  if (callee.type !== "MemberExpression") return null;
  if (callee.object.type !== "Identifier" || callee.object.name !== PLAIN_TEST) return null;
  return { modifier: callee.property.type === "Identifier" ? callee.property.name : "computed" };
}

function testsOf(source: string): readonly AcceptanceTest[] {
  const tests: AcceptanceTest[] = [];
  for (const node of nodesOf(source)) {
    if (node.type !== "CallExpression") continue;
    const callee = testCalleeOf(node.callee);
    if (callee === null) continue;
    const [name] = node.arguments;
    tests.push({ name: name?.type === "StringLiteral" ? name.value : null, modifier: callee.modifier });
  }
  return tests;
}

function citationProblems(spec: string, acceptanceSources: readonly string[]): readonly string[] {
  const ids = captures(spec, DEFINITION);
  const criteria = criteriaOf(spec);
  const tests = acceptanceSources.flatMap(testsOf);
  const missing = [
    ...(criteria.length === 0 ? ["no acceptance criteria found in the spec"] : []),
    ...(tests.length === 0 ? ["no acceptance tests found"] : []),
  ];
  if (missing.length > 0) return missing;
  return [
    ...numberingProblems(ids),
    ...criterionProblems(criteria, ids),
    ...mentionProblems(spec, criteria, ids),
    ...testProblems(
      criteria.map(({ id }) => id),
      tests,
    ),
  ];
}

const VALID_SPEC = `
- **FR-1** — Does one thing.
- **FR-2** — Does another.
- **NF-1** — Is fast.
- **D-1** — Ships a binary.
- **C-1** — Runs on Bun.
- **AC-1** — Running it does one thing fast. (FR-1, NF-1)
- **AC-2** — Running it does another. (FR-2)
`;
const PROVEN = `test("AC-1 it does one thing", () => {});`;
const VALID_TESTS = [PROVEN, `test("AC-2 it does another", () => {});`];

describe("the spec and the acceptance suite", () => {
  test("agent-record's spec and acceptance tests cite each other completely", () => {
    const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const sources = readdirSync(ACCEPTANCE)
      .filter((file) => file.endsWith(".acceptance.ts"))
      .map((file) => readFileSync(join(ACCEPTANCE, file), "utf8"));
    expect(citationProblems(spec, sources)).toEqual([]);
  });
});

describe("the citation check", () => {
  test("passes a spec and suite that cite each other completely", () => {
    expect(citationProblems(VALID_SPEC, VALID_TESTS)).toEqual([]);
  });

  test("finds no criteria or no tests as a problem rather than passing vacuously", () => {
    expect(citationProblems("", [])).toEqual([
      "no acceptance criteria found in the spec",
      "no acceptance tests found",
    ]);
  });

  test("flags an acceptance test whose name cites no criterion", () => {
    const tests = [...VALID_TESTS, `test("it does a third thing", () => {});`];
    expect(citationProblems(VALID_SPEC, tests)).toEqual([
      'acceptance test "it does a third thing" cites no criterion',
    ]);
  });

  test("flags an acceptance test citing a criterion the spec lacks", () => {
    const tests = [...VALID_TESTS, `test("AC-9 it does nothing", () => {});`];
    expect(citationProblems(VALID_SPEC, tests)).toEqual([
      'acceptance test "AC-9 it does nothing" cites AC-9, which the spec does not define',
    ]);
  });

  test("flags a criterion with no test", () => {
    expect(citationProblems(VALID_SPEC, [PROVEN])).toEqual(["AC-2 has no acceptance test"]);
  });

  test("flags a todo or a skipped test as not proving its criterion", () => {
    const tests = [PROVEN, `test.todo("AC-2 it does another", () => {});`];
    expect(citationProblems(VALID_SPEC, tests)).toEqual([
      'acceptance test "AC-2 it does another" is a test.todo, not a test that runs',
      "AC-2 has no acceptance test",
    ]);
    const skipped = [PROVEN, `test.skip("AC-2 it does another", () => {});`];
    expect(citationProblems(VALID_SPEC, skipped)).toEqual([
      'acceptance test "AC-2 it does another" is a test.skip, not a test that runs',
      "AC-2 has no acceptance test",
    ]);
  });

  test("flags an id that is not a family and a whole number", () => {
    const spec = VALID_SPEC.replace("**FR-2**", "**FR-1a**").replace("(FR-2)", "(FR-1a)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["FR-1a is not a family and a whole number"]);
  });

  test("flags a family not numbered from 1 without gaps", () => {
    const spec = VALID_SPEC.replace("**FR-2**", "**FR-3**").replace("(FR-2)", "(FR-3)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual([
      "FR is numbered FR-1, FR-3 instead of from 1 without gaps",
    ]);
  });

  test("flags a criterion that cites no requirement", () => {
    const spec = VALID_SPEC.replace("Running it does another. (FR-2)", "Running it does another.");
    expect(citationProblems(spec, VALID_TESTS)).toEqual([
      "AC-2 cites no requirement",
      "FR-2 is cited by no criterion",
    ]);
  });

  test("flags a criterion citing a requirement the spec lacks", () => {
    const spec = VALID_SPEC.replace("(FR-2)", "(FR-2, FR-7)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["FR-7 is mentioned but not defined"]);
  });

  test("flags a criterion citing an id of a family the spec lacks", () => {
    const spec = VALID_SPEC.replace("(FR-2)", "(FR-2, XR-1)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["XR-1 is mentioned but not defined"]);
  });

  test("flags a criterion citing an undefined id that is not a whole number", () => {
    const spec = VALID_SPEC.replace("(FR-2)", "(FR-2, FR-1a)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["FR-1a is mentioned but not defined"]);
  });

  test("flags a requirement no criterion cites", () => {
    const spec = VALID_SPEC.replace("(FR-1, NF-1)", "(FR-1)");
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["NF-1 is cited by no criterion"]);
  });

  test("flags an id mentioned in prose that the spec does not define", () => {
    const spec = `${VALID_SPEC}\nSee FR-9 for details.\n`;
    expect(citationProblems(spec, VALID_TESTS)).toEqual(["FR-9 is mentioned but not defined"]);
  });

  test("flags an acceptance test whose name is not a string literal", () => {
    const tests = [...VALID_TESTS, "test(name, () => {});"];
    expect(citationProblems(VALID_SPEC, tests)).toEqual([
      "an acceptance test's name is not a string literal",
    ]);
  });
});
