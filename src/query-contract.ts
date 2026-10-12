import type { Database } from "bun:sqlite";
import { refuser } from "./coded-error";

export type Cell = string | number | null;

export type Rows = { readonly columns: readonly string[]; readonly rows: readonly (readonly Cell[])[] };

export type QueryResult = Rows & { readonly denominator: string; readonly note: string | null };

export type QueryContext = {
  readonly arg: string;
  readonly home: string;
  readonly maxRows: number;
};

export type Query = {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly run: (db: Database, ctx: QueryContext) => QueryResult;
};

export const refuseQuery = refuser<{
  readonly unknown_query: { readonly name: string };
  readonly not_a_count: { readonly value: string };
  readonly ambiguous_session: { readonly prefix: string; readonly matches: readonly string[] };
}>({
  unknown_query: {
    message: ({ name }) => `no query named ${name}`,
    resolve: () => "agent-record query list",
  },
  not_a_count: {
    message: ({ value }) => `--rows ${value} is not a count of at least 1`,
    resolve: () => "--rows <n>, a whole number of at least 1",
  },
  ambiguous_session: {
    message: ({ prefix, matches }) =>
      `${prefix} matches more than one session, among them ${matches.join(" and ")}`,
    resolve: ({ matches }) => `agent-record query thread <a longer prefix of one of: ${matches.join(", ")}>`,
  },
});
