import type { Database } from "bun:sqlite";
import type { Flags } from "./cli-flags";
import { refuser } from "./coded-error";

export type Cell = string | number | null;

export type Rows = { readonly columns: readonly string[]; readonly rows: readonly (readonly Cell[])[] };

export type QueryResult = Rows & { readonly denominator: string; readonly note: string | null };

export type CappedResult = QueryResult & { readonly more: string | null };

export type QueryContext<Flag extends string = string> = {
  readonly arg: string;
  readonly flags: Flags<Flag>;
  readonly home: string;
  readonly maxRows: number;
};

export type Query<Flag extends string = string> = {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags: readonly Flag[];
  readonly run: (db: Database, ctx: QueryContext<Flag>) => QueryResult;
};

export const refuseQuery = refuser<{
  readonly unknown_query: { readonly name: string };
  readonly not_a_count: { readonly flag: string; readonly value: string };
  readonly not_a_time: { readonly flag: string; readonly value: string };
  readonly ambiguous_session: { readonly prefix: string; readonly matches: readonly string[] };
  readonly unknown_signal: { readonly name: string; readonly signals: readonly string[] };
  readonly unknown_grouping: { readonly by: string; readonly groupings: readonly string[] };
  readonly unknown_commit: { readonly prefix: string };
  readonly ambiguous_commit: { readonly prefix: string; readonly matches: readonly string[] };
  readonly from_before_commit: { readonly from: string; readonly sha: string; readonly at: string };
  readonly unknown_skill: { readonly skill: string; readonly skills: readonly string[] };
}>({
  unknown_query: {
    message: ({ name }) => `no query named ${name}`,
    resolve: () => "agent-record query list",
  },
  not_a_count: {
    message: ({ flag, value }) => `--${flag} ${value} is not a count of at least 1`,
    resolve: ({ flag }) => `--${flag} <n>, a whole number of at least 1`,
  },
  not_a_time: {
    message: ({ flag, value }) => `--${flag} ${value} is not a time`,
    resolve: ({ flag }) =>
      `--${flag} <ts>, an ISO time with Z or an offset, to the minute or finer, such as 2026-09-01T10:30Z`,
  },
  ambiguous_session: {
    message: ({ prefix, matches }) =>
      `${prefix} matches more than one session, among them ${matches.join(" and ")}`,
    resolve: ({ matches }) => `agent-record query thread <a longer prefix of one of: ${matches.join(", ")}>`,
  },
  unknown_signal: {
    message: ({ name }) => `no signal named ${name}`,
    resolve: ({ signals }) => `one of: ${signals.join(", ")}`,
  },
  unknown_grouping: {
    message: ({ by }) => `--by ${by} is not a grouping`,
    resolve: ({ groupings }) => `--by <${groupings.join("|")}>`,
  },
  unknown_commit: {
    message: ({ prefix }) => `no commit in the record starts with ${prefix}`,
    resolve: () => "agent-record sync, then a prefix of a commit in a repo a session worked in",
  },
  ambiguous_commit: {
    message: ({ prefix, matches }) =>
      `${prefix} matches more than one commit, among them ${matches.join(" and ")}`,
    resolve: ({ matches }) => `a longer prefix of one of: ${matches.join(", ")}`,
  },
  from_before_commit: {
    message: ({ from, sha, at }) => `--from ${from} is before commit ${sha} at ${at}`,
    resolve: ({ at }) => `--from <ts> at or after ${at}`,
  },
  unknown_skill: {
    message: ({ skill }) => `no load of a skill named ${skill} is in the record`,
    resolve: ({ skills }) => `--skill <name>, named without its plugin, one of: ${skills.join(", ")}`,
  },
});
