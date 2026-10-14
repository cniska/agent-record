import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./env";
import { asUnprivileged, scratchEnv } from "./fixtures.test-support";
import { type MirrorPass, mirrorArchive, readMirror } from "./mirror";
import { archiveDir, mirrorArchiveDir, mirrorStampPath } from "./paths";

const AT = new Date("2026-10-14T12:00:00Z");
const TRANSCRIPT = join("claude", "-Users-x-code-demo", "a.jsonl");
const MODIFIED = new Date("2026-10-01T08:00:00Z");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "agent-record-mirror-"));
  roots.push(root);
  return scratchEnv(root);
}

function archived(env: Env, path: string, text: string, modified = MODIFIED): string {
  const file = join(archiveDir(env), path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  utimesSync(file, modified, modified);
  return file;
}

const mirrored = (env: Env, path: string) => join(mirrorArchiveDir(env), path);

describe("mirroring the archive", () => {
  test("copies every archive file with its bytes and modification time, and records when", () => {
    const env = newEnv();
    archived(env, TRANSCRIPT, "one\n");
    archived(env, join("codex", "sessions", "r.jsonl"), "two\n");

    expect(mirrorArchive(env, AT)).toEqual({
      report: { state: "mirrored", path: env.mirrorDir, files: 2, bytes: 8 },
      failures: [],
    });
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("one\n");
    expect(statSync(mirrored(env, TRANSCRIPT)).mtime).toEqual(MODIFIED);
    expect(readFileSync(mirrored(env, join("codex", "sessions", "r.jsonl")), "utf8")).toBe("two\n");
    expect(readMirror(env)).toEqual({ kind: "mirrored", path: env.mirrorDir, at: AT });
  });

  test("writes nothing when no archive file changed", () => {
    const env = newEnv();
    archived(env, TRANSCRIPT, "one\n");
    mirrorArchive(env, AT);
    writeFileSync(mirrored(env, TRANSCRIPT), "ONE\n");
    utimesSync(mirrored(env, TRANSCRIPT), MODIFIED, MODIFIED);

    expect(mirrorArchive(env, AT).report).toMatchObject({ files: 0, bytes: 0 });
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("ONE\n");
  });

  test("replaces a mirror copy whose archive file grew or was rewritten", () => {
    const env = newEnv();
    archived(env, TRANSCRIPT, "one\n");
    mirrorArchive(env, AT);
    archived(env, TRANSCRIPT, "one\ntwo\n", new Date("2026-10-02T08:00:00Z"));
    expect(mirrorArchive(env, AT).report).toMatchObject({ files: 1, bytes: 8 });
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("one\ntwo\n");

    archived(env, TRANSCRIPT, "two\n", new Date("2026-10-03T08:00:00Z"));
    mirrorArchive(env, AT);
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("two\n");
  });

  test("sets a copy aside before a shorter or empty archive file replaces it, and not before a longer one", () => {
    const env = newEnv();
    const backup = `${mirrored(env, TRANSCRIPT)}.agent-record-backup`;
    archived(env, TRANSCRIPT, "one\ntwo\n");
    mirrorArchive(env, AT);

    archived(env, TRANSCRIPT, "new\n", new Date("2026-10-02T08:00:00Z"));
    expect(mirrorArchive(env, AT).failures).toEqual([]);
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("new\n");
    expect(readFileSync(backup, "utf8")).toBe("one\ntwo\n");

    archived(env, TRANSCRIPT, "", new Date("2026-10-03T08:00:00Z"));
    mirrorArchive(env, AT);
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("");
    expect(readFileSync(backup, "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(`${backup}-2`, "utf8")).toBe("new\n");

    archived(env, TRANSCRIPT, "longer\n", new Date("2026-10-04T08:00:00Z"));
    mirrorArchive(env, AT);
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("longer\n");
    expect(existsSync(`${backup}-3`)).toBe(false);
  });

  test("leaves out a copy the archive left half written", () => {
    const env = newEnv();
    archived(env, TRANSCRIPT, "one\n");
    archived(env, `${TRANSCRIPT}.part`, "on");
    expect(mirrorArchive(env, AT).report).toMatchObject({ files: 1 });
    expect(existsSync(`${mirrored(env, TRANSCRIPT)}.part`)).toBe(false);
  });

  test("keeps a mirror copy the archive no longer holds", () => {
    const env = newEnv();
    const file = archived(env, TRANSCRIPT, "one\n");
    mirrorArchive(env, AT);
    rmSync(file);
    mirrorArchive(env, AT);
    expect(readFileSync(mirrored(env, TRANSCRIPT), "utf8")).toBe("one\n");
  });

  test("records a mirror of an empty archive", () => {
    const env = newEnv();
    expect(mirrorArchive(env, AT).report).toEqual({
      state: "mirrored",
      path: env.mirrorDir,
      files: 0,
      bytes: 0,
    });
    expect(readMirror(env)).toMatchObject({ kind: "mirrored", at: AT });
  });

  test("writes nothing when the mirror folder's parent does not exist", () => {
    const base = newEnv();
    const env = { ...base, mirrorDir: join(base.home, "iCloud Drive", "agent-record") };
    archived(env, TRANSCRIPT, "one\n");

    const pass = mirrorArchive(env, AT);
    expect(pass).toEqual({
      report: {
        state: "unreachable",
        path: env.mirrorDir,
        detail: `there is no folder at ${join(base.home, "iCloud Drive")}`,
      },
      failures: [],
    });
    expect(existsSync(join(base.home, "iCloud Drive"))).toBe(false);
    expect(readMirror(env)).toEqual({
      kind: "unreachable",
      path: env.mirrorDir,
      detail: `there is no folder at ${join(base.home, "iCloud Drive")}`,
    });
  });

  test("lists a copy it cannot write, mirrors the rest, and records no time", () => {
    const env = newEnv();
    archived(env, TRANSCRIPT, "one\n");
    archived(env, join("codex", "sessions", "r.jsonl"), "two\n");
    const blocked = join(mirrorArchiveDir(env), "claude");
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o500);

    let pass: MirrorPass;
    try {
      pass = asUnprivileged(env, () => mirrorArchive(env, AT));
    } finally {
      chmodSync(blocked, 0o755);
    }

    expect(pass.report).toMatchObject({ state: "mirrored", files: 1, bytes: 4 });
    expect(pass.failures).toEqual([
      {
        path: mirrored(env, TRANSCRIPT),
        error: expect.objectContaining({
          kind: "refusal",
          code: "mirror_unwritable",
          resolve: `free space in or fix the permissions of ${dirname(mirrored(env, TRANSCRIPT))}, then run agent-record sync; until then the mirror keeps the copy made before`,
        }),
      },
    ]);
    expect(readFileSync(mirrored(env, join("codex", "sessions", "r.jsonl")), "utf8")).toBe("two\n");
    expect(existsSync(mirrorStampPath(env))).toBe(false);
    expect(readMirror(env)).toEqual({ kind: "never", path: env.mirrorDir });
  });

  test("lists a mirror time it cannot write under its own code", () => {
    const env = newEnv();
    mkdirSync(env.mirrorDir, { recursive: true });
    chmodSync(env.mirrorDir, 0o500);
    let pass: MirrorPass;
    try {
      pass = asUnprivileged(env, () => mirrorArchive(env, AT));
    } finally {
      chmodSync(env.mirrorDir, 0o755);
    }
    expect(pass.failures).toEqual([
      {
        path: mirrorStampPath(env),
        error: expect.objectContaining({
          code: "mirror_stamp_unwritable",
          resolve: `free space in or fix the permissions of ${env.mirrorDir}, then run agent-record sync; until then doctor reads the time recorded before`,
        }),
      },
    ]);
    expect(readMirror(env)).toEqual({ kind: "never", path: env.mirrorDir });
  });

  test("reads a mirror time it cannot parse as unreadable", () => {
    const env = newEnv();
    mkdirSync(env.mirrorDir, { recursive: true });
    writeFileSync(mirrorStampPath(env), "yesterday\n");
    expect(readMirror(env)).toEqual({ kind: "unreadable", path: env.mirrorDir, stamp: mirrorStampPath(env) });
  });
});
