import { type Command, Ran } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { recordDoctor } from "./doctor";
import { agentLoaded } from "./ingest-launchd";

export const doctorCommand: Command = {
  name: "doctor",
  usage: "usage: agent-record doctor",
  summary: "judge whether the record is current and readable, naming the fix for each problem",
  run(args) {
    parseArgs(args, { positionals: [0, 0], flags: [] }, "agent-record doctor");
    const report = recordDoctor(process.env, { agentLoaded, now: Date.now() });
    return new Ran(report, report.failing === 0 ? 0 : 1);
  },
};
