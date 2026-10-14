import { allCommands, findCommand } from "./cli-commands";
import { type Runtime, refuseUsage } from "./cli-contract";
import { listing, writeError, writeResult } from "./cli-output";

export async function runCli(runtime: Runtime): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  if (name === undefined) {
    writeResult("agent-record", listing(await allCommands()));
    process.exitCode = 0;
    return;
  }
  const command = await findCommand(name);
  if (command === undefined) {
    process.exitCode = writeError("agent-record", refuseUsage("unknown_command", { name }));
    return;
  }
  try {
    const ran = command.run(args, runtime);
    writeResult(command.name, ran.value);
    process.exitCode = ran.exitCode;
  } catch (error) {
    process.exitCode = writeError(command.name, error);
  }
}
