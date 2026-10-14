import { describe, expect, test } from "bun:test";
import { PLATFORMS, platformManifest, platformTarball, shimManifest } from "./build-npm";

describe("the npm packages", () => {
  test("name one package per release build, pinned to the shim's version", () => {
    expect(PLATFORMS.map(platformTarball)).toEqual([
      "agent-record-darwin-arm64.tar.gz",
      "agent-record-linux-x64.tar.gz",
    ]);
    expect(shimManifest("1.2.3", PLATFORMS)).toMatchObject({
      name: "@cniska/agent-record",
      version: "1.2.3",
      bin: { "agent-record": "bin/agent-record.cjs" },
      files: ["bin/agent-record.cjs", "launcher.sh"],
      optionalDependencies: {
        "@cniska/agent-record-darwin-arm64": "1.2.3",
        "@cniska/agent-record-linux-x64": "1.2.3",
      },
    });
  });

  test("install a platform's binary only on that platform", () => {
    expect(platformManifest({ os: "linux", cpu: "x64" }, "1.2.3")).toMatchObject({
      name: "@cniska/agent-record-linux-x64",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["x64"],
      files: ["agent-record"],
    });
  });

  test("name the repository trusted publishing proves the provenance of", () => {
    for (const manifest of [
      shimManifest("1.2.3", PLATFORMS),
      platformManifest({ os: "darwin", cpu: "arm64" }, "1.2.3"),
    ])
      expect(manifest).toMatchObject({
        repository: { type: "git", url: "git+https://github.com/cniska/agent-record.git" },
      });
  });
});
