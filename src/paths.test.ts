import { describe, expect, test } from "bun:test";
import { dbPath, locksDir, stateDir } from "./paths";

const HOME = "/home/owner";

describe("the XDG layout", () => {
  test("defaults each directory under the home directory", () => {
    const env = { HOME };
    expect(dbPath(env)).toBe("/home/owner/.local/share/agent-record/sessions.db");
    expect(stateDir(env)).toBe("/home/owner/.local/state/agent-record");
  });

  test("follows an absolute XDG variable for each directory", () => {
    const env = { HOME, XDG_DATA_HOME: "/x/data", XDG_STATE_HOME: "/x/state" };
    expect(dbPath(env)).toBe("/x/data/agent-record/sessions.db");
    expect(stateDir(env)).toBe("/x/state/agent-record");
    expect(locksDir(env)).toBe("/x/state/agent-record/locks");
  });

  test("ignores a relative or empty XDG variable, as the XDG spec says", () => {
    const env = { HOME, XDG_DATA_HOME: "", XDG_STATE_HOME: "./state" };
    expect(dbPath(env)).toBe("/home/owner/.local/share/agent-record/sessions.db");
    expect(stateDir(env)).toBe("/home/owner/.local/state/agent-record");
  });
});
