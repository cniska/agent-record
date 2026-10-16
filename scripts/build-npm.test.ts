import { describe, expect, test } from "bun:test";
import { launcher, PLATFORMS, platformManifest, platformTarball, shimManifest } from "./build-npm";

describe("the npm packages", () => {
  test("name one package per release build, pinned to the shim's version", () => {
    expect(PLATFORMS.map(platformTarball)).toEqual([
      "agent-record-darwin-arm64.tar.gz",
      "agent-record-linux-x64.tar.gz",
    ]);
    expect(shimManifest("1.2.3", PLATFORMS)).toMatchObject({
      name: "@cniska/agent-record",
      version: "1.2.3",
      bin: { "agent-record": "bin/agent-record" },
      files: ["bin/agent-record"],
      optionalDependencies: {
        "@cniska/agent-record-darwin-arm64": "1.2.3",
        "@cniska/agent-record-linux-x64": "1.2.3",
      },
    });
    expect(shimManifest("1.2.3", PLATFORMS)).not.toHaveProperty("engines");
  });

  test("ship a POSIX shell launcher that names the release builds", () => {
    const script = launcher(PLATFORMS);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("\nbuilds='darwin-arm64 linux-x64'\n");
    expect(script).not.toContain("__BUILDS__");
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
