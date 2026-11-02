import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./env";
import { errorCode } from "./error-read";

export type Channel = "homebrew" | "npm" | "bun" | "curl";

const INSTALLER = "https://github.com/cniska/agent-record/releases/latest/download/install.sh";

const UPGRADE_COMMANDS: Readonly<Record<Channel, string>> = {
  homebrew: "brew upgrade agent-record",
  npm: "npm update -g @cniska/agent-record",
  bun: "bun update -g @cniska/agent-record",
  curl: `curl -fsSL ${INSTALLER} | sh`,
};

export function upgradeAdvice(channel: Channel | null): string {
  if (channel !== null) return UPGRADE_COMMANDS[channel];
  const { homebrew, npm, bun, curl } = UPGRADE_COMMANDS;
  return `upgrade agent-record the way it was installed: ${homebrew}, ${npm}, ${bun}, or ${curl}`;
}

const HOMEBREW_BUILD = /\/Cellar\/agent-record\/[^/]+\/bin\/agent-record$/;
const PACKAGED_BUILD =
  /^(?:@cniska\/agent-record\/node_modules\/)?@cniska\/agent-record-[a-z0-9]+-[a-z0-9]+\/agent-record$/;
const NPM_GLOBAL_MODULES = /\/lib\/node_modules\/(.+)$/;

type Install = { readonly execPath: string; readonly env: Env };

const GONE: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR"]);

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (GONE.has(errorCode(error))) return path;
    throw error;
  }
}

function inBunGlobal(build: string, env: Env): boolean {
  const modules = `${realOrSelf(join(env.bunInstall, "install", "global", "node_modules"))}/`;
  return build.startsWith(modules) && PACKAGED_BUILD.test(build.slice(modules.length));
}

function inNpmGlobal(build: string): boolean {
  const packaged = NPM_GLOBAL_MODULES.exec(build)?.[1];
  return packaged !== undefined && PACKAGED_BUILD.test(packaged);
}

export function installChannel({ execPath, env }: Install): Channel | null {
  const build = realOrSelf(execPath);
  if (HOMEBREW_BUILD.test(build)) return "homebrew";
  if (inBunGlobal(build, env)) return "bun";
  if (inNpmGlobal(build)) return "npm";
  if (build === realOrSelf(join(env.home, ".local", "bin", "agent-record"))) return "curl";
  return null;
}
