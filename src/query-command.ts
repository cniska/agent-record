import { type Command, Ran, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { listQueries, runQuery } from "./query-ops";
import { findQuery } from "./query-registry";
import { DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";

export const queryCommand: Command = {
  name: "query",
  usage: "usage: agent-record query <name> [arg] [--rows <n>] | agent-record query list",
  summary: `ask the database a named question; ${DEFAULT_MAX_ROWS} rows print unless --rows widens them`,
  run(args) {
    const [name, ...rest] = args;
    if (name === undefined || name === "list") {
      parseArgs(rest, { positionals: [0, 0], flags: [] }, "agent-record query list");
      return new Ran(listQueries(), 0);
    }
    const query = findQuery(name);
    if (query === undefined)
      throw new UsageError(`no query named ${name}; agent-record query list names them`);
    const { positionals, flags } = parseArgs(
      rest,
      { positionals: [0, 1], flags: ["rows"] },
      `agent-record query ${name}`,
    );
    return new Ran(runQuery(query, positionals[0] ?? null, rowsOf(flags.rows)), 0);
  },
};
