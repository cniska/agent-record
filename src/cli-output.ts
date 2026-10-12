import type { Command } from "./cli-contract";
import { codedOf, errorRecord } from "./coded-error";

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
