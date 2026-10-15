import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { errorCode } from "./error-read";

export type Env = {
  readonly home: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly tmpDir: string;
  readonly mirrorDir: string;
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

const ICLOUD_DRIVE_MIRROR = ["Library", "Mobile Documents", "com~apple~CloudDocs", "agent-record"] as const;

function absoluteOr(raw: RawEnv, variable: string, home: string, fallback: readonly string[]): string {
  const value = raw[variable];
  return value !== undefined && isAbsolute(value) ? value : join(home, ...fallback);
}

const COMMAND_VARIABLE = "AGENT_RECORD_COMMAND";

export type Invocation = {
  readonly raw: RawEnv;
  readonly argv0: string;
  readonly cwd: string;
  readonly execPath: string;
};

const NOT_RUNNABLE_HERE: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch (error) {
    if (NOT_RUNNABLE_HERE.has(errorCode(error))) return false;
    throw error;
  }
}

function onPath(name: string, raw: RawEnv): string | null {
  const dirs = (raw.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  return dirs.map((dir) => join(dir, name)).find(isExecutableFile) ?? null;
}

function typedCommand(argv0: string, cwd: string, raw: RawEnv): string | null {
  if (argv0 === "") return null;
  if (!argv0.includes("/")) return onPath(argv0, raw);
  const typed = resolve(cwd, argv0);
  return isExecutableFile(typed) ? typed : null;
}

export function releaseCommand({ raw, argv0, cwd, execPath }: Invocation): string {
  const given = raw[COMMAND_VARIABLE];
  if (given !== undefined && isAbsolute(given)) return given;
  return typedCommand(argv0, cwd, raw) ?? execPath;
}

export function parseEnv(raw: RawEnv): Env {
  const home = homeOf(raw);
  return {
    home,
    dataHome: absoluteOr(raw, "XDG_DATA_HOME", home, [".local", "share"]),
    stateHome: absoluteOr(raw, "XDG_STATE_HOME", home, [".local", "state"]),
    tmpDir: tempOf(raw),
    mirrorDir: absoluteOr(raw, "AGENT_RECORD_MIRROR", home, ICLOUD_DRIVE_MIRROR),
  };
}
