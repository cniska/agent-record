import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseProblems, schemaOf } from "./release-check";

const at = (tag: string, schema: number) => ({ tag, schema });
const candidate = (version: string, schema: number) => ({ tag: `v${version}`, version, schema });

describe("a release tag", () => {
  test("passes the first release, and a patch that keeps the schema version", () => {
    expect(releaseProblems(candidate("0.1.0", 15), null)).toEqual([]);
    expect(releaseProblems(candidate("0.1.1", 15), at("v0.1.0", 15))).toEqual([]);
  });

  test("passes a minor or major release that changes the schema version", () => {
    expect(releaseProblems(candidate("0.2.0", 16), at("v0.1.4", 15))).toEqual([]);
    expect(releaseProblems(candidate("1.0.0", 16), at("v0.9.0", 15))).toEqual([]);
  });

  test("fails a patch release that changes the schema version", () => {
    expect(releaseProblems(candidate("0.1.1", 16), at("v0.1.0", 15))).toEqual([
      "the schema version changed from 15 to 16 since v0.1.0, so this is a minor or major release, not a patch",
    ]);
  });

  test("fails a tag that does not name package.json's version, or is not newer", () => {
    expect(releaseProblems({ tag: "v0.2.0", version: "0.1.0", schema: 15 }, null)).toEqual([
      "the tag v0.2.0 does not name package.json's version 0.1.0",
    ]);
    expect(releaseProblems(candidate("0.1.0", 15), at("v0.1.0", 15))).toEqual([
      "0.1.0 is not newer than the previous release v0.1.0",
    ]);
    expect(releaseProblems(candidate("0.1.0-rc.1", 15), null)).toEqual([
      "package.json's version 0.1.0-rc.1 is not of the form x.y.z",
    ]);
  });

  test("reads the schema version the record declares", () => {
    expect(
      schemaOf(readFileSync(join(import.meta.dir, "..", "src", "db-schema.ts"), "utf8")),
    ).toBeGreaterThan(0);
    expect(() => schemaOf("export const OTHER = 1;")).toThrow("src/db-schema.ts declares no SCHEMA_VERSION");
  });
});
