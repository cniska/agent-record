import { refuseUsage } from "./cli-contract";

type Flags<Flag extends string> = Readonly<Partial<Record<Flag, string>>>;

function scan<Flag extends string>(
  args: readonly string[],
  known: readonly Flag[],
  usage: string,
): { readonly positionals: readonly string[]; readonly flags: Flags<Flag> } {
  const positionals: string[] = [];
  const flags: Partial<Record<Flag, string>> = {};
  const rest = [...args];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (!arg.startsWith("--")) {
      positionals.push(arg.trim());
      continue;
    }
    const flag = known.find((name) => `--${name}` === arg);
    if (flag === undefined) throw refuseUsage("unknown_flag", { usage, flag: arg });
    const value = rest.shift();
    if (value === undefined || value.startsWith("--")) {
      throw refuseUsage("flag_without_value", { usage, flag: arg });
    }
    if (flags[flag] !== undefined) throw refuseUsage("flag_repeated", { usage, flag: arg });
    flags[flag] = value;
  }
  return { positionals, flags };
}

export function parseFlags<Flag extends string>(
  args: readonly string[],
  known: readonly Flag[],
  usage: string,
): Flags<Flag> {
  const { positionals, flags } = scan(args, known, usage);
  if (positionals.length > 0) throw refuseUsage("argument_count", { usage, takes: 0, got: positionals });
  return flags;
}

export function parseArg<Flag extends string>(
  args: readonly string[],
  known: readonly Flag[],
  usage: string,
): { readonly arg: string; readonly flags: Flags<Flag> } {
  const { positionals, flags } = scan(args, known, usage);
  const [arg, ...extra] = positionals;
  if (arg === undefined || extra.length > 0) {
    throw refuseUsage("argument_count", { usage, takes: 1, got: positionals });
  }
  if (arg === "") throw refuseUsage("blank_argument", { usage });
  return { arg, flags };
}
