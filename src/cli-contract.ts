import { CodedError } from "./coded-error";

export type Command = {
  name: string;
  usage: string;
  summary: string;
  run(args: string[]): unknown;
};

export class UsageError extends CodedError<"usage", Record<string, never>> {
  constructor(message: string) {
    super("usage", message, {}, "", "refusal");
  }
}
