import { type Command, faultCommand } from "./cli-contract";
import { CodedError, errorRecord } from "./coded-error";

function codedOf(error: unknown): CodedError {
  if (error instanceof CodedError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return faultCommand("command_failed", { detail });
}

export function writeResult(command: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify({ command, ok: true, result: value ?? null })}\n`);
}

export function writeError(command: string, error: unknown): number {
  process.stderr.write(`${JSON.stringify({ command, ok: false, error: errorRecord(codedOf(error)) })}\n`);
  return 1;
}

export function listing(commands: readonly Command[]): {
  commands: { name: string; usage: string; summary: string }[];
} {
  return { commands: commands.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}
