import { bootoutCommand, bootstrapCommand, installAgent } from "./agent-launchd";
import { type Command, refuseUsage } from "./cli-contract";
import { parseArg } from "./cli-flags";

export const agentCommand: Command = {
  name: "agent",
  usage: "agent-record agent install",
  summary: "write the launchd agent that syncs every 15 minutes",
  run(args) {
    const { arg: verb } = parseArg(args, [], agentCommand.usage);
    if (verb !== "install") throw refuseUsage("unknown_verb", { usage: agentCommand.usage, verb });
    const { path, state } = installAgent();
    if (state === "current") return { value: { path, unchanged: true }, exitCode: 0 };
    return {
      value: { path, unchanged: false, next: bootstrapCommand(path), remove: bootoutCommand() },
      exitCode: 0,
    };
  },
};
