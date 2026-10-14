import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorDetail } from "./error-read";
import { refuseUpdate } from "./update-contract";

const NAME = "agent-record";
const TARGETS: ReadonlySet<string> = new Set(["darwin-arm64", "linux-x64"]);
const TAG_PREFIX = "v";
const DOWNLOAD_TIMEOUT_MS = 300_000;
const SHA256 = /^([0-9a-f]{64})\s/;

const ReleaseJson = z.looseObject({
  tag_name: z.string(),
  assets: z.array(z.looseObject({ name: z.string(), browser_download_url: z.string() })),
});

export type LatestRelease = { readonly version: string; readonly tarball: string; readonly checksum: string };

export function platformTarget(): string {
  const target = `${process.platform}-${process.arch}`;
  if (!TARGETS.has(target)) throw refuseUpdate("no_build_for_platform", { platform: target });
  return target;
}

async function fetched(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": NAME },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw refuseUpdate(
      "update_failed",
      { detail: `${url} could not be reached: ${errorDetail(error)}` },
      error,
    );
  }
  if (!response.ok) throw refuseUpdate("update_failed", { detail: `${url} answered ${response.status}` });
  return response;
}

export async function latestRelease(releasesUrl: string, target: string): Promise<LatestRelease> {
  const parsed = ReleaseJson.safeParse(await (await fetched(releasesUrl)).json());
  if (!parsed.success) throw refuseUpdate("update_failed", { detail: `${releasesUrl} answered no release` });
  const { tag_name: tag, assets } = parsed.data;
  const url = (name: string) => {
    const asset = assets.find((candidate) => candidate.name === name);
    if (asset === undefined) throw refuseUpdate("update_failed", { detail: `release ${tag} has no ${name}` });
    return asset.browser_download_url;
  };
  return {
    version: tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag,
    tarball: url(`${NAME}-${target}.tar.gz`),
    checksum: url(`${NAME}-${target}.sha256`),
  };
}

export async function downloadedBinary(release: LatestRelease, tmpDir: string): Promise<string> {
  const [tarball, checksum] = await Promise.all([
    fetched(release.tarball).then((response) => response.arrayBuffer()),
    fetched(release.checksum).then((response) => response.text()),
  ]);
  const [, expected] = SHA256.exec(checksum) ?? [];
  if (expected === undefined)
    throw refuseUpdate("update_failed", { detail: `${release.checksum} holds no sha256` });
  const actual = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  if (actual !== expected) {
    throw refuseUpdate("update_failed", {
      detail: `the ${release.version} download does not match its sha256`,
    });
  }
  const dir = mkdtempSync(join(tmpDir, `${NAME}-update-`));
  const archive = join(dir, `${NAME}.tar.gz`);
  writeFileSync(archive, new Uint8Array(tarball));
  const untar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir, NAME], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (untar.exitCode !== 0) {
    throw refuseUpdate("update_failed", {
      detail: `the ${release.version} download holds no ${NAME}: ${untar.stderr.toString().trim()}`,
    });
  }
  return join(dir, NAME);
}
