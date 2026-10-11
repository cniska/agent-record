import { CodedError } from "./coded-error";

export type Command = {
  name: string;
  usage: string;
  summary: string;
  run(args: string[]): Ran;
};

export class Ran {
  constructor(
    readonly value: unknown,
    readonly exitCode: 0 | 1,
  ) {}
}

export class UsageError extends CodedError<"usage", Record<string, never>> {
  constructor(message: string) {
    super("usage", message, {}, "", "refusal");
  }
}
