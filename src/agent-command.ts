import { bootoutCommand, bootstrapCommand, installAgent } from "./agent-launchd";
import { type Command, Ran, refuseUsage } from "./cli-contract";
import { parseArg } from "./cli-flags";

export const agentCommand: Command = {
  name: "agent",
  usage: "agent-record agent install",
  summary: "write the launchd agent that syncs every 15 minutes",
  run(args) {
    const { arg: verb } = parseArg(args, [], agentCommand.usage);
    if (verb !== "install") throw refuseUsage("unknown_verb", { usage: agentCommand.usage, verb });
    const { path, state } = installAgent();
    if (state === "current") return new Ran({ path, unchanged: true }, 0);
    return new Ran({ path, unchanged: false, next: bootstrapCommand(path), remove: bootoutCommand() }, 0);
  },
};
