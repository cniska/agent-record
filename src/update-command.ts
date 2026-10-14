import { type Command, refuseUsage } from "./cli-contract";
import { rollBack, runUpdate } from "./update";

const USAGE = "agent-record update [--staged | --rollback]";

export const updateCommand: Command = {
  name: "update",
  startsUpdateCheck: false,
  usage: USAGE,
  summary: "stage the latest release beside the installed build, or roll the staged one back",
  async run(args, runtime) {
    const [flag, ...rest] = args;
    if (rest.length > 0) throw refuseUsage("argument_count", { usage: USAGE, takes: 0, got: rest });
    switch (flag) {
      case undefined:
        return { value: await runUpdate(runtime, "now"), exitCode: 0 };
      case "--staged":
        return { value: await runUpdate(runtime, "staged"), exitCode: 0 };
      case "--rollback":
        return { value: rollBack(runtime), exitCode: 0 };
      default:
        if (flag.startsWith("--")) throw refuseUsage("unknown_flag", { usage: USAGE, flag });
        throw refuseUsage("argument_count", { usage: USAGE, takes: 0, got: args });
    }
  },
};
