#!/usr/bin/env bun
import { allCommands, COMMAND_NAMES, findCommand } from "./cli-commands";
import { UsageError } from "./cli-contract";
import { listing, writeError, writeResult } from "./cli-output";

const [name, ...args] = process.argv.slice(2);
const command = await findCommand(name);

if (name === undefined) {
  process.exitCode = writeResult("agent-record", listing(await allCommands()));
} else if (command === undefined) {
  process.exitCode = writeError(
    "agent-record",
    new UsageError(`${name} is not an agent-record command; agent-record with no command lists them`),
    `usage: agent-record ${COMMAND_NAMES.join("|")}`,
  );
} else {
  try {
    const value = await command.run(args);
    process.exitCode = writeResult(command.name, value);
  } catch (error) {
    process.exitCode = writeError(command.name, error, command.usage);
  }
}
