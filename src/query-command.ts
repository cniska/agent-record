import type { Command } from "./cli-contract";
import { parseArg, parseFlags } from "./cli-flags";
import { refuseQuery } from "./query-contract";
import { listQueries, runQuery } from "./query-ops";
import { findQuery } from "./query-registry";
import { DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";

export const queryCommand: Command = {
  name: "query",
  usage: "agent-record query <name> <arg> [--rows <n>] | agent-record query list",
  summary: `ask the database a named question; ${DEFAULT_MAX_ROWS} rows print unless --rows widens them`,
  run(args) {
    const [name, ...rest] = args;
    if (name === undefined || name === "list") {
      parseFlags(rest, [], queryCommand.usage);
      return { value: listQueries(), exitCode: 0 };
    }
    const query = findQuery(name);
    if (query === undefined) throw refuseQuery("unknown_query", { name });
    const { arg, flags } = parseArg(rest, ["rows", ...query.flags], query.usage);
    const { rows, ...own } = flags;
    return { value: runQuery(query, { arg, flags: own, maxRows: rowsOf(rows) }), exitCode: 0 };
  },
};
