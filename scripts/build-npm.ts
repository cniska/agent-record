import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";

export type Platform = { readonly os: "darwin" | "linux"; readonly cpu: "arm64" | "x64" };

export const PLATFORMS: readonly Platform[] = [
  { os: "darwin", cpu: "arm64" },
  { os: "linux", cpu: "x64" },
];

const SCOPE = "@cniska";
const NAME = "agent-record";
const REPOSITORY = { type: "git", url: "git+https://github.com/cniska/agent-record.git" } as const;
const HOMEPAGE = "https://github.com/cniska/agent-record";
const SUMMARY =
  "Query your past agent work: every coding-agent session on this machine, in one SQLite record.";

const platformTarget = ({ os, cpu }: Platform): string => `${os}-${cpu}`;

const platformPackage = (platform: Platform): string => `${SCOPE}/${NAME}-${platformTarget(platform)}`;

export const platformTarball = (platform: Platform): string => `${NAME}-${platformTarget(platform)}.tar.gz`;

export function platformManifest(platform: Platform, version: string): Record<string, unknown> {
  return {
    name: platformPackage(platform),
    version,
    description: `The ${platformTarget(platform)} build of ${SCOPE}/${NAME}.`,
    license: "MIT",
    homepage: HOMEPAGE,
    repository: REPOSITORY,
    os: [platform.os],
    cpu: [platform.cpu],
    files: [NAME],
  };
}

export function shimManifest(version: string, platforms: readonly Platform[]): Record<string, unknown> {
  return {
    name: `${SCOPE}/${NAME}`,
    version,
    description: SUMMARY,
    license: "MIT",
    homepage: HOMEPAGE,
    repository: REPOSITORY,
    bugs: { url: `${HOMEPAGE}/issues` },
    keywords: ["agent", "claude-code", "codex", "cli", "sessions", "sqlite"],
    bin: { [NAME]: `bin/${NAME}.cjs` },
    files: [`bin/${NAME}.cjs`],
    engines: { node: ">=20" },
    optionalDependencies: Object.fromEntries(
      platforms.map((platform) => [platformPackage(platform), version]),
    ),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function extractBinary(tarball: string, into: string): void {
  const ran = spawnSync("tar", ["-xzf", tarball, "-C", into, NAME], { stdio: "inherit" });
  if (ran.status !== 0) throw new Error(`${tarball} holds no ${NAME} binary`);
}

function buildTree(artifactsDir: string, outDir: string): void {
  const root = join(import.meta.dir, "..");
  rmSync(outDir, { recursive: true, force: true });
  for (const platform of PLATFORMS) {
    const dir = join(outDir, platformTarget(platform));
    mkdirSync(dir, { recursive: true });
    extractBinary(join(artifactsDir, platformTarball(platform)), dir);
    writeJson(join(dir, "package.json"), platformManifest(platform, version));
  }
  const shim = join(outDir, NAME);
  mkdirSync(join(shim, "bin"), { recursive: true });
  writeJson(join(shim, "package.json"), shimManifest(version, PLATFORMS));
  copyFileSync(join(root, "npm", `${NAME}.cjs`), join(shim, "bin", `${NAME}.cjs`));
  copyFileSync(join(root, "README.md"), join(shim, "README.md"));
  copyFileSync(join(root, "LICENSE"), join(shim, "LICENSE"));
  chmodSync(join(shim, "bin", `${NAME}.cjs`), 0o755);
}

if (import.meta.main) {
  const [artifactsDir, outDir] = process.argv.slice(2);
  if (artifactsDir === undefined || outDir === undefined) {
    process.stderr.write("usage: bun scripts/build-npm.ts <artifacts-dir> <out-dir>\n");
    process.exit(2);
  }
  buildTree(artifactsDir, outDir);
  console.log(`${outDir}: ${SCOPE}/${NAME} ${version} and ${PLATFORMS.length} platform packages`);
}
