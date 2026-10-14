import { agentLoaded } from "./agent-launchd";
import { type Command, Ran } from "./cli-contract";
import { parseFlags } from "./cli-flags";
import { recordDoctor } from "./doctor";

export const doctorCommand: Command = {
  name: "doctor",
  usage: "agent-record doctor",
  summary: "judge whether the record is current and readable, naming the fix for each problem",
  run(args) {
    parseFlags(args, [], doctorCommand.usage);
    const report = recordDoctor(process.env, { agentLoaded, now: Date.now() });
    return new Ran(report, report.failing === 0 ? 0 : 1);
  },
};
