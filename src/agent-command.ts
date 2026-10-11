import { type Command, Ran, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { bootoutCommand, bootstrapCommand, installAgent } from "./ingest-launchd";

const USAGE = "usage: agent-record agent install";

export const agentCommand: Command = {
  name: "agent",
  usage: USAGE,
  summary: "write the launchd agent that syncs every 15 minutes",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "install") throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, "agent-record agent install");
    const { path, state } = installAgent();
    if (state === "current") return new Ran({ path, unchanged: true }, 0);
    return new Ran({ path, unchanged: false, next: bootstrapCommand(path), remove: bootoutCommand() }, 0);
  },
};
