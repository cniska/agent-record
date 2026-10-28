import { unreachable } from "./assert";
import { GATES, type Gate } from "./ingest-event-kinds";
import type { GateRow, HookRow, VerdictRow } from "./query-signal-record";

const UPHELD = "upheld";

const UNFIXED = "unfixed";

export const PENDING = "pending";

export const JUDGEMENTS = [UPHELD, UNFIXED, PENDING] as const;

type FalseStop = `${Gate} ${string}`;

export type Judgement = (typeof JUDGEMENTS)[number] | FalseStop;

export const isFalseStop = (kind: string): boolean => GATES.some((gate) => kind.startsWith(`${gate} `));

export const REVIEW_KINDS = ["return", "reviewed commit"] as const;

export const BLOCK_SOURCES = [
  "permission prompt",
  "auto-mode denial",
  "commit gate",
  "verdict gate",
] as const;

type Found<Row extends HookRow> = { readonly at: number; readonly row: Row };

export type Judged = { readonly row: HookRow; readonly kind: Judgement };

export type Reviewed = { readonly row: HookRow; readonly kind: (typeof REVIEW_KINDS)[number] };

export type Blocked = { readonly row: HookRow; readonly kind: (typeof BLOCK_SOURCES)[number] };

type GateOrVerdict = GateRow | VerdictRow;

export const repoNamed = (row: HookRow): string | null =>
  row.event === "gate" || row.event === "verdict" ? row.repo : null;

const sameActor = (a: HookRow, b: HookRow): boolean => a.sessionId === b.sessionId && a.agent === b.agent;

const isGateOrVerdict = (row: HookRow): row is GateOrVerdict =>
  row.event === "gate" || row.event === "verdict";

export const isCommitAllow = (row: HookRow): row is GateRow =>
  row.event === "gate" && row.gate === "commit" && row.decision === "allow";

const isDenial = (row: HookRow): row is GateRow => row.event === "gate" && row.decision === "deny";

function firstAfter<Row extends HookRow>(
  rows: readonly HookRow[],
  index: number,
  found: (row: HookRow) => row is Row,
): Found<Row> | null {
  for (let at = index + 1; at < rows.length; at++) {
    const row = rows[at];
    if (row !== undefined && found(row)) return { at, row };
  }
  return null;
}

function anyBetween(
  rows: readonly HookRow[],
  from: number,
  until: number,
  found: (row: HookRow) => boolean,
): boolean {
  return rows.slice(from + 1, until).some(found);
}

function repeatsStop(rows: readonly HookRow[], index: number, denial: GateRow): boolean {
  for (let at = index - 1; at >= 0; at--) {
    const row = rows[at];
    if (row === undefined || !sameActor(row, denial) || !isGateOrVerdict(row)) continue;
    return (
      isDenial(row) && row.gate === denial.gate && row.reason === denial.reason && row.repo === denial.repo
    );
  }
  return false;
}

function judgeVerdictStop(rows: readonly HookRow[], index: number, denial: GateRow): Judgement {
  const next = firstAfter(
    rows,
    index,
    (row): row is GateOrVerdict => sameActor(row, denial) && isGateOrVerdict(row),
  );
  const ended = next?.row;
  return ended?.event === "gate" && ended.gate === "verdict" && ended.decision === "allow" ? UNFIXED : UPHELD;
}

function judgeCommitStop(rows: readonly HookRow[], index: number, denial: GateRow): Judgement {
  if (denial.fingerprint !== null) return UPHELD;
  const allow = firstAfter(
    rows,
    index,
    (row): row is GateRow =>
      sameActor(row, denial) && isCommitAllow(row) && (denial.repo === null || row.repo === denial.repo),
  );
  if (allow === null) return UPHELD;
  const reviewed = anyBetween(
    rows,
    index,
    allow.at,
    (row) => row.event === "verdict" && row.repo === allow.row.repo,
  );
  return reviewed ? UPHELD : `${denial.gate} ${denial.reason}`;
}

function judge(rows: readonly HookRow[], index: number, denial: GateRow): Judgement {
  if (!rows.slice(index + 1).some((row) => row.sessionId === denial.sessionId)) return PENDING;
  if (denial.gate === "verdict") return judgeVerdictStop(rows, index, denial);
  return judgeCommitStop(rows, index, denial);
}

export function judgeDenials(rows: readonly HookRow[]): readonly Judged[] {
  return rows.flatMap((row, index) =>
    isDenial(row) && !repeatsStop(rows, index, row) ? [{ row, kind: judge(rows, index, row) }] : [],
  );
}

type Round = { accepted: boolean; returns: VerdictRow[] };

export function reviewRounds(rows: readonly HookRow[]): readonly Reviewed[] {
  const rounds = new Map<string, Round>();
  const reviewed: Reviewed[] = [];
  const roundOf = (sessionId: string, repo: string): Round => {
    const key = JSON.stringify([sessionId, repo]);
    const known = rounds.get(key);
    if (known !== undefined) return known;
    const fresh: Round = { accepted: false, returns: [] };
    rounds.set(key, fresh);
    return fresh;
  };
  for (const row of rows) {
    if (row.event === "verdict") {
      const round = roundOf(row.sessionId, row.repo);
      switch (row.verdict) {
        case "return":
          round.returns.push(row);
          break;
        case "accept":
          round.accepted = true;
          break;
        default:
          unreachable(row.verdict);
      }
      continue;
    }
    if (!isCommitAllow(row) || row.repo === null) continue;
    const round = roundOf(row.sessionId, row.repo);
    if (round.accepted) {
      reviewed.push(...round.returns.map((returned) => ({ row: returned, kind: "return" as const })));
      reviewed.push({ row, kind: "reviewed commit" });
    }
    round.accepted = false;
    round.returns = [];
  }
  return reviewed.toSorted((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at));
}

function sourceOf(row: HookRow): Blocked["kind"] | null {
  switch (row.event) {
    case "permission_prompt":
      return "permission prompt";
    case "permission_denied":
      return "auto-mode denial";
    case "gate":
      if (row.decision !== "deny") return null;
      return row.gate === "verdict" ? "verdict gate" : "commit gate";
    case "verdict":
      return null;
    default:
      return unreachable(row);
  }
}

export function blocksOf(rows: readonly HookRow[]): readonly Blocked[] {
  return rows.flatMap((row) => {
    const kind = sourceOf(row);
    return kind === null ? [] : [{ row, kind }];
  });
}
