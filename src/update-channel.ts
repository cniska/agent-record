import { realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "./env";

export const Channel = z.enum(["homebrew", "npm", "bun", "curl"]);
export type Channel = z.infer<typeof Channel>;

const INSTALLER = "https://github.com/cniska/agent-record/releases/latest/download/install.sh";

const RegistryLatest = z.looseObject({ version: z.string() });
const LatestRelease = z.looseObject({ tag_name: z.string() });

const FORMULA_URL = /^\s*url\s+"([^"]+)"/gm;
const RELEASE_DOWNLOAD = /\/releases\/download\/([^/]+)\//;

function formulaTag(formula: string): string | null {
  const tags = [...formula.matchAll(FORMULA_URL)].map(
    (match) => RELEASE_DOWNLOAD.exec(match[1] ?? "")?.[1] ?? null,
  );
  const [first = null] = tags;
  return tags.every((tag) => tag === first) ? first : null;
}

type LatestSource = { readonly url: string; readonly read: (body: string) => string | null };

const REGISTRY: LatestSource = {
  url: "https://registry.npmjs.org/@cniska/agent-record/latest",
  read: (body) => RegistryLatest.parse(JSON.parse(body)).version,
};

type ChannelWays = { readonly upgrade: string; readonly latest: LatestSource };

const CHANNELS: Readonly<Record<Channel, ChannelWays>> = {
  homebrew: {
    upgrade: "brew upgrade agent-record",
    latest: {
      url: "https://raw.githubusercontent.com/cniska/homebrew-tap/main/Formula/agent-record.rb",
      read: formulaTag,
    },
  },
  npm: { upgrade: "npm update -g @cniska/agent-record", latest: REGISTRY },
  bun: { upgrade: "bun update -g @cniska/agent-record", latest: REGISTRY },
  curl: {
    upgrade: `curl -fsSL ${INSTALLER} | sh`,
    latest: {
      url: "https://api.github.com/repos/cniska/agent-record/releases/latest",
      read: (body) => LatestRelease.parse(JSON.parse(body)).tag_name,
    },
  },
};

export function latestSource(channel: Channel): LatestSource {
  return CHANNELS[channel].latest;
}

export function upgradeAdvice(channel: Channel | null): string {
  if (channel !== null) return CHANNELS[channel].upgrade;
  const { homebrew, npm, bun, curl } = CHANNELS;
  return `upgrade agent-record the way it was installed: ${homebrew.upgrade}, ${npm.upgrade}, ${bun.upgrade}, or ${curl.upgrade}`;
}

const HOMEBREW_BUILD = /\/Cellar\/agent-record\/[^/]+\/bin\/agent-record$/;
const PACKAGED_BUILD =
  /^(?:@cniska\/agent-record\/node_modules\/)?@cniska\/agent-record-[a-z0-9]+-[a-z0-9]+\/agent-record$/;
const NPM_GLOBAL_MODULES = /\/lib\/node_modules\/(.+)$/;

type Install = { readonly execPath: string; readonly env: Env };

function realOrAsGiven(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inBunGlobal(build: string, env: Env): boolean {
  const modules = `${realOrAsGiven(join(env.bunInstall, "install", "global", "node_modules"))}/`;
  return build.startsWith(modules) && PACKAGED_BUILD.test(build.slice(modules.length));
}

function inNpmGlobal(build: string): boolean {
  const packaged = NPM_GLOBAL_MODULES.exec(build)?.[1];
  return packaged !== undefined && PACKAGED_BUILD.test(packaged);
}

export function installChannel({ execPath, env }: Install): Channel | null {
  const build = realOrAsGiven(execPath);
  if (HOMEBREW_BUILD.test(build)) return "homebrew";
  if (inBunGlobal(build, env)) return "bun";
  if (inNpmGlobal(build)) return "npm";
  if (build === realOrAsGiven(join(env.home, ".local", "bin", "agent-record"))) return "curl";
  return null;
}
