import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeError } from "./cli-output";
import { CodedError } from "./coded-error";

const spies: { mockRestore: () => void }[] = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function printed(error: unknown): unknown {
  const lines: string[] = [];
  spies.push(
    spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }),
  );
  writeError("query", error);
  return JSON.parse(lines.join(""));
}

describe("an error on stderr", () => {
  test("carries a refusal's code, facts and the command that resolves it beside its message", () => {
    const refused = new CodedError("no_session", "no session k7m2qx4d is on record", {
      meta: { session: "k7m2qx4d" },
      resolve: "agent-record query <name> <arg> [--rows <n>]",
      kind: "refusal",
    });
    expect(printed(refused)).toEqual({
      command: "query",
      ok: false,
      error: {
        kind: "refusal",
        code: "no_session",
        message: "no session k7m2qx4d is on record",
        meta: { session: "k7m2qx4d" },
        resolve: "agent-record query <name> <arg> [--rows <n>]",
      },
    });
  });

  test("names an error with no code as a fault from the command, handed to the owner as a bug", () => {
    for (const thrown of [new Error("disk full"), "disk full"]) {
      expect(printed(thrown)).toEqual({
        command: "query",
        ok: false,
        error: {
          kind: "fault",
          code: "command_failed",
          message: "the command failed unexpectedly: disk full",
          meta: { detail: "disk full" },
          resolve:
            "stop and hand this error to the owner as a bug in agent-record; no command you run resolves it",
        },
      });
    }
  });

  test("names a coded fault as a fault", () => {
    const fault = new CodedError("invariant_failed", "invariant failed: x", {
      meta: { condition: "x" },
      resolve: "bug",
      kind: "fault",
    });
    expect(printed(fault)).toMatchObject({ error: { kind: "fault", code: "invariant_failed" } });
  });
});
