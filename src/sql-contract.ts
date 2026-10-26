import { refuser } from "./coded-error";

export const refuseSql = refuser<{
  readonly sql_invalid: { readonly statement: string; readonly detail: string };
  readonly sql_unknown_column: {
    readonly statement: string;
    readonly column: string;
    readonly columns: Readonly<Record<string, readonly string[]>>;
  };
  readonly sql_writes: { readonly statement: string };
  readonly sql_columns_repeated: { readonly statement: string; readonly column: string };
  readonly sql_columns_reordered: { readonly statement: string; readonly column: string };
  readonly sql_blob: { readonly statement: string; readonly column: string };
}>({
  sql_invalid: {
    message: ({ statement, detail }) => `SQLite cannot run ${JSON.stringify(statement)}: ${detail}`,
    resolve: () => "fix the statement and run it again",
  },
  sql_unknown_column: {
    message: ({ statement, column }) =>
      `${JSON.stringify(statement)} names the column ${column}, which SQLite cannot find`,
    resolve: ({ columns }) =>
      `use a column of the tables it names: ${Object.entries(columns)
        .map(([table, names]) => `${table} (${names.join(", ")})`)
        .join("; ")}`,
  },
  sql_writes: {
    message: ({ statement }) => `${JSON.stringify(statement)} writes, and agent-record sql only reads`,
    resolve: () => "run a read-only SELECT",
  },
  sql_columns_repeated: {
    message: ({ statement, column }) =>
      `${JSON.stringify(statement)} names the column ${column} more than once, so one of them would be lost`,
    resolve: () => "name each column once, with AS",
  },
  sql_columns_reordered: {
    message: ({ statement, column }) =>
      `${JSON.stringify(statement)} names the column ${column}, which reads as a whole number and would print ahead of the columns named before it`,
    resolve: () => "name the column with AS so it does not read as a whole number",
  },
  sql_blob: {
    message: ({ statement, column }) =>
      `${JSON.stringify(statement)} returns a blob in ${column}, and agent-record sql prints only text, numbers and null`,
    resolve: ({ column }) => `select hex(${column}) instead`,
  },
});
