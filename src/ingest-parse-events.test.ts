import { describe, expect, test } from "bun:test";
import { parseEventChunk } from "./ingest-parse-events";

const COMMON = {
  v: 1,
  ts: "2026-10-14T08:51:25Z",
  session: "0b8f2c1e-7d4a-4e2b-9c3f-5a6d7e8f9a0b",
  agent: "a4444444444444444",
  cwd: "/h/code/demo",
};

const line = (fields: Record<string, unknown>): string => JSON.stringify({ ...COMMON, ...fields });

const GATE = {
  event: "gate",
  gate: "commit",
  decision: "deny",
  reason: "changed_since_accept",
  repo: "/h/code/demo",
  head: "1234567890abcdef1234567890abcdef12345678",
  fingerprint: "0123456789abcdef",
};

const VERDICT = { event: "verdict", verdict: "return", repo: "/h/code/demo", fingerprint: "fedcba98" };

const PROMPT = { event: "permission_prompt", tool: "Bash" };

const DENIED = {
  event: "permission_denied",
  tool: "Bash",
  tool_use: "toolu_01",
  reason: "rule",
  rule: "no-force-push",
};

const PLACE = {
  ts: "2026-10-14T08:51:25.000Z",
  session: COMMON.session,
  agent: COMMON.agent,
  cwd: COMMON.cwd,
};

describe("a hook event log", () => {
  test("records each kept kind with the fields its kind carries, at its line", () => {
    const { events, dropped } = parseEventChunk([line(GATE), line(VERDICT), line(PROMPT), line(DENIED)], 7);

    expect(dropped).toEqual([]);
    expect(events).toEqual<object[]>([
      {
        ...PLACE,
        srcLine: 7,
        event: "gate",
        gate: "commit",
        decision: "deny",
        reason: "changed_since_accept",
        repo: "/h/code/demo",
        head: "1234567890abcdef1234567890abcdef12345678",
        fingerprint: "0123456789abcdef",
      },
      {
        ...PLACE,
        srcLine: 8,
        event: "verdict",
        verdict: "return",
        repo: "/h/code/demo",
        fingerprint: "fedcba98",
        counted: null,
      },
      { ...PLACE, srcLine: 9, event: "permission_prompt", tool: "Bash" },
      {
        ...PLACE,
        srcLine: 10,
        event: "permission_denied",
        tool: "Bash",
        toolUse: "toolu_01",
        reason: "rule",
        rule: "no-force-push",
      },
    ]);
  });

  test("keeps a null field null and reads a main-agent line with no agent", () => {
    const { events } = parseEventChunk(
      [
        line({
          ...GATE,
          agent: null,
          cwd: null,
          reason: "repo_unclear",
          repo: null,
          head: null,
          fingerprint: null,
        }),
      ],
      1,
    );

    expect(events).toEqual<object[]>([
      {
        ...PLACE,
        agent: null,
        cwd: null,
        srcLine: 1,
        event: "gate",
        gate: "commit",
        decision: "deny",
        reason: "repo_unclear",
        repo: null,
        head: null,
        fingerprint: null,
      },
    ]);
  });

  test("reads a verdict's finding counts, conflicts and cited rules", () => {
    const findings = { critical: 0, major: 1, minor: 2, fix: 1, consider: 0, unrated: 0 };
    const { events } = parseEventChunk(
      [line({ ...VERDICT, findings, conflicts: 1, rules: ["Clear names", "Clear names"] })],
      1,
    );

    expect(events).toEqual<object[]>([
      {
        ...PLACE,
        srcLine: 1,
        event: "verdict",
        verdict: "return",
        repo: "/h/code/demo",
        fingerprint: "fedcba98",
        counted: { findings, conflicts: 1, rules: ["Clear names", "Clear names"] },
      },
    ]);
  });

  test("reads a verdict whose counts are all null as one that counted none", () => {
    const { events } = parseEventChunk(
      [line({ ...VERDICT, findings: null, conflicts: null, rules: null })],
      1,
    );

    expect(events.map((event) => (event.event === "verdict" ? event.counted : undefined))).toEqual([null]);
  });

  test("reports a verdict whose counts are malformed or only partly there", () => {
    const findings = { critical: 0, major: 1, minor: 2, fix: 1, consider: 0, unrated: 0 };
    const { events, dropped } = parseEventChunk(
      [
        line({ ...VERDICT, findings: { ...findings, major: -1 }, conflicts: 0, rules: [] }),
        line({ ...VERDICT, findings: { ...findings, unrated: undefined }, conflicts: 0, rules: [] }),
        line({ ...VERDICT, findings, conflicts: 1.5, rules: [] }),
        line({ ...VERDICT, findings, conflicts: 0, rules: [""] }),
        line({ ...VERDICT, conflicts: 3 }),
        line({ ...VERDICT, findings, conflicts: 0 }),
        line({ ...VERDICT, findings: { ...findings, minor: 1_000_000_000 }, conflicts: 0, rules: [] }),
        line({ ...VERDICT, findings, conflicts: 1_000_000_000, rules: [] }),
        line({ ...VERDICT, findings, conflicts: null, rules: [] }),
      ],
      1,
    );

    expect(dropped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events).toEqual([]);
  });

  test("reads a field added to a kind without a new version", () => {
    expect(parseEventChunk([line({ ...PROMPT, mode: "auto" })], 1).events).toHaveLength(1);
  });

  test("reports a kept line it cannot read, and a line of another version", () => {
    const { events, dropped } = parseEventChunk(
      [
        "{not json",
        line({ ...GATE, decision: "maybe" }),
        line({ ...VERDICT, fingerprint: null }),
        line({ ...PROMPT, session: null }),
        line({ ...PROMPT, ts: "yesterday" }),
        line({ ...PROMPT, v: 2 }),
        JSON.stringify({ ...PROMPT, v: undefined }),
        line(PROMPT),
      ],
      1,
    );

    expect(dropped).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((event) => event.srcLine)).toEqual([8]);
  });

  test("skips a version 1 line of a kind the record does not keep, without a report", () => {
    expect(parseEventChunk([line({ event: "push", ref: "main" })], 1)).toEqual({ events: [], dropped: [] });
  });
});
