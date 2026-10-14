import { agentLoaded } from "./agent-launchd";
import type { Command } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { recordDoctor } from "./doctor";

export const doctorCommand: Command = {
  name: "doctor",
  startsUpdateCheck: true,
  usage: "agent-record doctor",
  summary: "judge whether the record is current and readable, naming the fix for each problem",
  run(args, runtime) {
    parseFlags(args, [], doctorCommand.usage);
    const report = recordDoctor({ ...runtime, agentLoaded });
    return { value: report, exitCode: report.failing === 0 ? 0 : 1 };
  },
};
