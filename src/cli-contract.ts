import { refuser } from "./coded-error";

export type Command = {
  name: string;
  usage: string;
  summary: string;
  run(args: string[], runtime: Runtime): CommandResult;
};

export type Runtime = { readonly now: () => Date; readonly heldRecordWaitMs: number };

export type CommandResult = { readonly value: unknown; readonly exitCode: 0 | 1 };

const TAKES = { 0: "no arguments", 1: "1 argument" } as const;

export const refuseUsage = refuser<{
  readonly unknown_command: { readonly name: string };
  readonly unknown_flag: { readonly usage: string; readonly flag: string };
  readonly flag_without_value: { readonly usage: string; readonly flag: string };
  readonly flag_repeated: { readonly usage: string; readonly flag: string };
  readonly argument_count: { readonly usage: string; readonly takes: 0 | 1; readonly got: readonly string[] };
  readonly blank_argument: { readonly usage: string };
  readonly unknown_verb: { readonly usage: string; readonly verb: string };
}>({
  unknown_command: {
    message: ({ name }) => `${name} is not an agent-record command`,
    resolve: () => "agent-record",
  },
  unknown_flag: {
    message: ({ flag }) => `${flag} is not a flag this command takes`,
    resolve: ({ usage }) => usage,
  },
  flag_without_value: {
    message: ({ flag }) => `${flag} needs a value`,
    resolve: ({ usage }) => usage,
  },
  flag_repeated: {
    message: ({ flag }) => `${flag} is given twice`,
    resolve: ({ usage }) => usage,
  },
  argument_count: {
    message: ({ takes, got }) =>
      `takes ${TAKES[takes]} and got ${got.length}${got.length === 0 ? "" : `: ${got.join(" ")}`}`,
    resolve: ({ usage }) => usage,
  },
  blank_argument: {
    message: () => "the argument is blank",
    resolve: ({ usage }) => usage,
  },
  unknown_verb: {
    message: ({ verb }) => `${verb} is not a verb of this command`,
    resolve: ({ usage }) => usage,
  },
});
