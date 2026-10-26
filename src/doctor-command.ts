import { agentLoaded } from "./agent-launchd";
import type { Command } from "./cli-contract";
import { parseSwitches } from "./cli-flags";
import { recordDoctor } from "./doctor";

export const doctorCommand: Command = {
  name: "doctor",
  usage: "agent-record doctor [--full]",
  summary: "judge whether the record is current and readable, naming the fix for each problem",
  run(args, runtime) {
    const switches = parseSwitches(args, ["full"], doctorCommand.usage);
    const { counts, checks } = recordDoctor({ ...runtime, agentLoaded });
    const shown = switches.has("full") ? checks : checks.filter(({ state }) => state !== "ok");
    return { value: { counts, checks: shown }, exitCode: counts.fail === 0 ? 0 : 1 };
  },
};
