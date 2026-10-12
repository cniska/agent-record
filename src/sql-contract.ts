import { refuser } from "./coded-error";

export const refuseSql = refuser<{
  readonly sql_invalid: { readonly statement: string; readonly detail: string };
  readonly sql_writes: { readonly statement: string };
}>({
  sql_invalid: {
    message: ({ statement, detail }) => `SQLite cannot run ${JSON.stringify(statement)}: ${detail}`,
    resolve: () => "fix the statement and run it again",
  },
  sql_writes: {
    message: ({ statement }) => `${JSON.stringify(statement)} writes, and agent-record sql only reads`,
    resolve: () => "run a read-only SELECT",
  },
});
