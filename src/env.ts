import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = {
  readonly home: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly tmpDir: string;
};

export type RawEnv = Readonly<Record<string, string | undefined>>;

const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;
const DEFAULT_TEMP = "/tmp";

function filled(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function homeOf(raw: RawEnv): string {
  return filled(raw.HOME) ? raw.HOME : userInfo().homedir;
}

function tempOf(raw: RawEnv): string {
  const temp = TEMP_VARIABLES.map((variable) => raw[variable]).find(filled);
  if (temp === undefined) return DEFAULT_TEMP;
  return temp.length > 1 && temp.endsWith("/") ? temp.slice(0, -1) : temp;
}

function xdgBase(raw: RawEnv, variable: string, home: string, fallback: readonly string[]): string {
  const value = raw[variable];
  return value !== undefined && isAbsolute(value) ? value : join(home, ...fallback);
}

export function parseEnv(raw: RawEnv): Env {
  const home = homeOf(raw);
  return {
    home,
    dataHome: xdgBase(raw, "XDG_DATA_HOME", home, [".local", "share"]),
    stateHome: xdgBase(raw, "XDG_STATE_HOME", home, [".local", "state"]),
    tmpDir: tempOf(raw),
  };
}
