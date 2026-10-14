import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { parseEnv } from "./env";
import { archiveDir, dbPath, locksDir, mirrorArchiveDir, mirrorStampPath, stateDir } from "./paths";

const HOME = "/home/owner";

describe("the XDG layout", () => {
  test("defaults each directory under the home directory", () => {
    const env = parseEnv({ HOME });
    expect(dbPath(env)).toBe("/home/owner/.local/share/agent-record/sessions.db");
    expect(archiveDir(env)).toBe("/home/owner/.local/share/agent-record/archive");
    expect(stateDir(env)).toBe("/home/owner/.local/state/agent-record");
  });

  test("follows an absolute XDG variable for each directory", () => {
    const env = parseEnv({ HOME, XDG_DATA_HOME: "/x/data", XDG_STATE_HOME: "/x/state" });
    expect(dbPath(env)).toBe("/x/data/agent-record/sessions.db");
    expect(archiveDir(env)).toBe("/x/data/agent-record/archive");
    expect(stateDir(env)).toBe("/x/state/agent-record");
    expect(locksDir(env)).toBe("/x/state/agent-record/locks");
  });

  test("ignores a relative or empty XDG variable, as the XDG spec says", () => {
    const env = parseEnv({ HOME, XDG_DATA_HOME: "", XDG_STATE_HOME: "./state" });
    expect(dbPath(env)).toBe("/home/owner/.local/share/agent-record/sessions.db");
    expect(stateDir(env)).toBe("/home/owner/.local/state/agent-record");
  });
});

describe("the mirror", () => {
  test("defaults to agent-record in iCloud Drive", () => {
    const env = parseEnv({ HOME });
    expect(env.mirrorDir).toBe("/home/owner/Library/Mobile Documents/com~apple~CloudDocs/agent-record");
    expect(mirrorArchiveDir(env)).toBe(
      "/home/owner/Library/Mobile Documents/com~apple~CloudDocs/agent-record/archive",
    );
    expect(mirrorStampPath(env)).toBe(
      "/home/owner/Library/Mobile Documents/com~apple~CloudDocs/agent-record/last-mirror",
    );
  });

  test("follows an absolute AGENT_RECORD_MIRROR, and ignores a relative or empty one", () => {
    expect(parseEnv({ HOME, AGENT_RECORD_MIRROR: "/Volumes/backup/record" }).mirrorDir).toBe(
      "/Volumes/backup/record",
    );
    for (const value of ["", "./record"])
      expect(parseEnv({ HOME, AGENT_RECORD_MIRROR: value }).mirrorDir).toBe(
        "/home/owner/Library/Mobile Documents/com~apple~CloudDocs/agent-record",
      );
  });
});

describe("the home directory", () => {
  test("falls back to the account's home when HOME is missing or blank", () => {
    expect(parseEnv({}).home).toBe(userInfo().homedir);
    expect(parseEnv({ HOME: " " }).home).toBe(userInfo().homedir);
  });
});

describe("the temp directory", () => {
  test("follows TMPDIR, then TMP, then TEMP, with one trailing slash dropped", () => {
    expect(parseEnv({ HOME, TMPDIR: "/x/tmp/" }).tmpDir).toBe("/x/tmp");
    expect(parseEnv({ HOME, TMPDIR: "", TMP: "/x/tmp", TEMP: "/x/temp" }).tmpDir).toBe("/x/tmp");
    expect(parseEnv({ HOME, TEMP: "/x/temp" }).tmpDir).toBe("/x/temp");
  });

  test("falls back to /tmp when none is set", () => {
    expect(parseEnv({ HOME }).tmpDir).toBe("/tmp");
  });
});
