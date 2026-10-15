import type { LoadRow, ResponseRow, SessionRow, TimedRow } from "./query-signal-record";
import { bodyVersion } from "./query-skill-version";
import { MINUTE_MS } from "./timestamp";

const NAMED_KINDS = ["reviewer", "coach", "researcher"] as const;

type NamedKind = (typeof NAMED_KINDS)[number];

const COORDINATOR_SKILL = "coordinate";

const WORKER_SKILL = "task";

const NO_SKILL = "none";

type Spent = { readonly output: number; readonly input: number };

export type Stretch = Spent & {
  readonly sessionId: string;
  readonly at: string;
  readonly step: string;
  readonly version: string | null;
  readonly minutes: number;
};

type Resets = {
  readonly ownerMessages: readonly TimedRow[];
  readonly subagentReturns: readonly TimedRow[];
};

type Priced = Spent & {
  readonly at: string;
  readonly spentMs: number;
  readonly opensTurn: boolean;
  readonly step: string;
  readonly version: string | null;
};

const ms = (at: string): number => Date.parse(at);

function namedKind(session: SessionRow): NamedKind | null {
  if (session.parentId === null || session.agentType === null) return null;
  const agentType = session.agentType;
  return NAMED_KINDS.find((kind) => agentType.includes(kind)) ?? null;
}

const preloadVersion = (preloads: readonly LoadRow[]): string | null =>
  preloads.length === 0 ? null : [...new Set(preloads.map(bodyVersion))].sort().join(", ");

const latestAtOrBefore = <Item extends TimedRow>(items: readonly Item[], at: number): Item | null =>
  items.findLast((item) => ms(item.at) <= at) ?? null;

function stepper(
  session: SessionRow,
  loads: readonly LoadRow[],
): (at: number) => {
  readonly step: string;
  readonly version: string | null;
} {
  const named = namedKind(session);
  const preloads = loads.filter((load) => load.preloaded);
  if (named !== null) {
    const version = preloadVersion(preloads);
    return () => ({ step: named, version });
  }
  const loaded = loads.filter((load) => !load.preloaded);
  const coordinates = loaded.filter((load) => load.skill === COORDINATOR_SKILL);
  const [first] = coordinates;
  if (first !== undefined) {
    return (at) => {
      const load = latestAtOrBefore(coordinates, at) ?? first;
      return { step: "coordinator", version: bodyVersion(load) };
    };
  }
  if (loaded.some((load) => load.skill === WORKER_SKILL)) {
    return (at) => {
      const load = latestAtOrBefore(loaded, at);
      return load === null
        ? { step: `worker ${NO_SKILL}`, version: null }
        : { step: `worker ${load.skill}`, version: bodyVersion(load) };
    };
  }
  const version = session.parentId === null ? null : session.agentType;
  return () => ({ step: "other", version });
}

function priced(
  session: SessionRow,
  responses: readonly ResponseRow[],
  loads: readonly LoadRow[],
  resets: { readonly owner: readonly TimedRow[]; readonly returns: readonly TimedRow[] },
): readonly Priced[] {
  const stepAt = stepper(session, loads);
  const timeAtOrBefore = (rows: readonly TimedRow[], at: number): number | null => {
    const row = latestAtOrBefore(rows, at);
    return row === null ? null : ms(row.at);
  };
  return responses.map((response, index) => {
    const at = ms(response.at);
    const previousAt = responses[index - 1]?.at ?? session.start;
    const previous = previousAt === null ? null : ms(previousAt);
    const owner = timeAtOrBefore(resets.owner, at);
    const opensTurn = owner !== null && (previous === null || owner > previous);
    const from = Math.min(
      at,
      Math.max(
        previous ?? at,
        owner ?? Number.NEGATIVE_INFINITY,
        timeAtOrBefore(resets.returns, at) ?? Number.NEGATIVE_INFINITY,
      ),
    );
    return { ...response, spentMs: at - from, opensTurn, ...stepAt(at) };
  });
}

function stretchesOf(sessionId: string, responses: readonly Priced[]): readonly Stretch[] {
  const stretches: Stretch[] = [];
  for (const response of responses) {
    const last = stretches.at(-1);
    if (
      last !== undefined &&
      !response.opensTurn &&
      last.step === response.step &&
      last.version === response.version
    ) {
      stretches[stretches.length - 1] = {
        ...last,
        output: last.output + response.output,
        input: last.input + response.input,
        minutes: last.minutes + response.spentMs / MINUTE_MS,
      };
      continue;
    }
    stretches.push({
      sessionId,
      at: response.at,
      step: response.step,
      version: response.version,
      output: response.output,
      input: response.input,
      minutes: response.spentMs / MINUTE_MS,
    });
  }
  return stretches;
}

export function stepStretches(
  sessions: readonly SessionRow[],
  responses: readonly ResponseRow[],
  loads: readonly LoadRow[],
  { ownerMessages, subagentReturns }: Resets,
): readonly Stretch[] {
  const responsesOf = Map.groupBy(responses, (response) => response.sessionId);
  const loadsOf = Map.groupBy(loads, (load) => load.sessionId);
  const inTimeOrder = (rows: readonly TimedRow[]): ReadonlyMap<string, readonly TimedRow[]> =>
    Map.groupBy(
      [...rows].sort((x, y) => ms(x.at) - ms(y.at)),
      (row) => row.sessionId,
    );
  const ownerOf = inTimeOrder(ownerMessages);
  const returnsOf = inTimeOrder(subagentReturns);
  return sessions.flatMap((session) => {
    const spent = responsesOf.get(session.id);
    if (spent === undefined) return [];
    const resets = { owner: ownerOf.get(session.id) ?? [], returns: returnsOf.get(session.id) ?? [] };
    return stretchesOf(session.id, priced(session, spent, loadsOf.get(session.id) ?? [], resets));
  });
}
