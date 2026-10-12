import { type Command, faultCommand } from "./cli-contract";
import { CodedError, type ErrorKind } from "./coded-error";

type ErrorRecord = {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly meta: Record<string, unknown>;
  readonly resolve: string;
};

function codedOf(error: unknown): CodedError {
  if (error instanceof CodedError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return faultCommand("command_failed", { detail });
}

function errorRecord(error: unknown): ErrorRecord {
  const { kind, code, message, meta, resolve } = codedOf(error);
  return { kind, code, message, meta: { ...meta }, resolve };
}

export function writeResult(command: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify({ command, ok: true, result: value ?? null })}\n`);
}

export function writeError(command: string, error: unknown): number {
  process.stderr.write(`${JSON.stringify({ command, ok: false, error: errorRecord(error) })}\n`);
  return 1;
}

export function listing(commands: readonly Command[]): {
  commands: { name: string; usage: string; summary: string }[];
} {
  return { commands: commands.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}
