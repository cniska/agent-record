import { type Command, Ran } from "./cli-contract";
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
      return new Ran(listQueries(), 0);
    }
    const query = findQuery(name);
    if (query === undefined) throw refuseQuery("unknown_query", { name });
    const { arg, flags } = parseArg(rest, ["rows"], query.usage);
    return new Ran(runQuery(query, arg, rowsOf(flags.rows)), 0);
  },
};
