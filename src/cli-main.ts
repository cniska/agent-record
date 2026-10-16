import { allCommands, findCommand } from "./cli-commands";
import { LISTING_NAMES, type Runtime, refuseUsage, VERSION_FLAG } from "./cli-contract";
import { listing, writeError, writeResult, writeVersion } from "./cli-output";

export const HELD_RECORD_WAIT_MS = 5000;

export async function runCli(runtime: Runtime): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  if (name === undefined || LISTING_NAMES.has(name)) {
    writeResult("agent-record", listing(await allCommands()));
    process.exitCode = 0;
    return;
  }
  if (name === VERSION_FLAG) {
    writeVersion(runtime.version);
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
