import { refuseUsage } from "./cli-contract";

export type Flags<Flag extends string> = Readonly<Partial<Record<Flag, string>>>;

type Known<Flag extends string, Switch extends string> = {
  readonly flags: readonly Flag[];
  readonly switches: readonly Switch[];
};

type Scanned<Flag extends string, Switch extends string> = {
  readonly positionals: readonly string[];
  readonly flags: Flags<Flag>;
  readonly switches: ReadonlySet<Switch>;
};

function scan<Flag extends string, Switch extends string>(
  args: readonly string[],
  known: Known<Flag, Switch>,
  usage: string,
): Scanned<Flag, Switch> {
  const positionals: string[] = [];
  const flags: Partial<Record<Flag, string>> = {};
  const switches = new Set<Switch>();
  const rest = [...args];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (!arg.startsWith("--")) {
      positionals.push(arg.trim());
      continue;
    }
    const on = known.switches.find((name) => `--${name}` === arg);
    if (on !== undefined) {
      if (switches.has(on)) throw refuseUsage("flag_repeated", { usage, flag: arg });
      switches.add(on);
      continue;
    }
    const flag = known.flags.find((name) => `--${name}` === arg);
    if (flag === undefined) throw refuseUsage("unknown_flag", { usage, flag: arg });
    const value = rest.shift();
    if (value === undefined || value.startsWith("--")) {
      throw refuseUsage("flag_without_value", { usage, flag: arg });
    }
    if (flags[flag] !== undefined) throw refuseUsage("flag_repeated", { usage, flag: arg });
    flags[flag] = value;
  }
  return { positionals, flags, switches };
}

function noArguments(positionals: readonly string[], usage: string): void {
  if (positionals.length > 0) throw refuseUsage("argument_count", { usage, takes: 0, got: positionals });
}

export function parseFlags<Flag extends string>(
  args: readonly string[],
  known: readonly Flag[],
  usage: string,
): Flags<Flag> {
  const { positionals, flags } = scan(args, { flags: known, switches: [] }, usage);
  noArguments(positionals, usage);
  return flags;
}

export function parseSwitches<Switch extends string>(
  args: readonly string[],
  known: readonly Switch[],
  usage: string,
): ReadonlySet<Switch> {
  const { positionals, switches } = scan(args, { flags: [], switches: known }, usage);
  noArguments(positionals, usage);
  return switches;
}

export function parseArg<Flag extends string>(
  args: readonly string[],
  known: readonly Flag[],
  usage: string,
): { readonly arg: string; readonly flags: Flags<Flag> } {
  const { positionals, flags } = scan(args, { flags: known, switches: [] }, usage);
  const [arg, ...extra] = positionals;
  if (arg === undefined || extra.length > 0) {
    throw refuseUsage("argument_count", { usage, takes: 1, got: positionals });
  }
  if (arg === "") throw refuseUsage("blank_argument", { usage });
  return { arg, flags };
}
