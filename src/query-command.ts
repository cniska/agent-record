import type { Command, CommandResult } from "./cli-contract";
import { parseArg, parseFlags } from "./cli-flags";
import { refuseQuery } from "./query-contract";
import { listQueries, runQuery } from "./query-ops";
import { findQuery } from "./query-registry";
import { DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";

export const queryCommand: Command = {
  name: "query",
  startsUpdateCheck: true,
  usage: "agent-record query <name> <arg> [--rows <n>] | agent-record query list",
  summary: `ask the database a named question; ${DEFAULT_MAX_ROWS} rows print unless --rows widens them`,
  run(args, runtime) {
    const [name, ...rest] = args;
    if (name === undefined || name.startsWith("--")) return listing(args);
    if (name === "list") return listing(rest);
    const query = findQuery(name);
    if (query === undefined) throw refuseQuery("unknown_query", { name });
    const { arg, flags } = parseArg(rest, ["rows", ...query.flags], query.usage);
    const { rows, ...own } = flags;
    return {
      value: runQuery(query, { arg, flags: own, maxRows: rowsOf(rows) }, runtime),
      exitCode: 0,
    };
  },
};

function listing(flagArgs: readonly string[]): CommandResult {
  parseFlags(flagArgs, [], queryCommand.usage);
  return { value: listQueries(), exitCode: 0 };
}
