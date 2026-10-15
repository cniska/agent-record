import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRelease, withDownloadedBinary } from "./update-fetch";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function serving(body: (path: string) => Response): string {
  const server = Bun.serve({ port: 0, fetch: (request) => body(new URL(request.url).pathname) });
  cleanups.push(() => server.stop(true));
  return `http://localhost:${server.port}`;
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-record-update-fetch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("latestRelease", () => {
  test("refuses a release answer that is not JSON", async () => {
    const url = serving(() => new Response("<html>sign in to this network</html>"));
    await expect(latestRelease(`${url}/releases/latest`, "darwin-arm64")).rejects.toMatchObject({
      code: "update_failed",
      message: expect.stringContaining("answered unreadably"),
    });
  });
});

function servingRelease(tarball: Uint8Array<ArrayBuffer>): { tarball: string; checksum: string } {
  const sha256 = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  const url = serving((path) =>
    path.endsWith(".sha256") ? new Response(`${sha256}  agent-record.tar.gz\n`) : new Response(tarball),
  );
  return { tarball: `${url}/agent-record.tar.gz`, checksum: `${url}/agent-record.sha256` };
}

function tarballHolding(content: string): Uint8Array<ArrayBuffer> {
  const dir = scratchDir();
  writeFileSync(join(dir, "agent-record"), content);
  const tar = Bun.spawnSync(["tar", "-czf", "-", "-C", dir, "agent-record"], { stdout: "pipe" });
  return new Uint8Array(tar.stdout);
}

describe("withDownloadedBinary", () => {
  test("hands over the extracted binary, then leaves no download behind", async () => {
    const tmpDir = scratchDir();
    const release = { version: "0.2.0", ...servingRelease(tarballHolding("built")) };

    expect(await withDownloadedBinary(release, tmpDir, (binary) => readFileSync(binary, "utf8"))).toBe(
      "built",
    );
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("refuses an archive without the binary and leaves no download behind", async () => {
    const tmpDir = scratchDir();
    const release = {
      version: "0.2.0",
      ...servingRelease(new Uint8Array(Bun.gzipSync(new Uint8Array(1024)))),
    };

    await expect(withDownloadedBinary(release, tmpDir, () => null)).rejects.toMatchObject({
      code: "update_failed",
    });
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});
