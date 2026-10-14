import { describe, expect, test } from "bun:test";
import { launcherOf } from "./env";

describe("the launcher a release was started by", () => {
  test("is the absolute path the launcher passes", () => {
    expect(launcherOf({ AGENT_RECORD_COMMAND: "/opt/homebrew/bin/agent-record" })).toBe(
      "/opt/homebrew/bin/agent-record",
    );
  });

  test("is none when no launcher passed one, or passed a relative path", () => {
    expect(launcherOf({})).toBeNull();
    expect(launcherOf({ AGENT_RECORD_COMMAND: "agent-record" })).toBeNull();
    expect(launcherOf({ AGENT_RECORD_COMMAND: "" })).toBeNull();
  });
});
