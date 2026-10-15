import { describe, expect, test } from "bun:test";
import { checkIsDue } from "./update-state";

const NOW = new Date("2026-10-14T12:00:00.000Z");

describe("checkIsDue", () => {
  test("is due with no readable check", () => {
    expect(checkIsDue({ kind: "never" }, NOW)).toBe(true);
    expect(checkIsDue({ kind: "unreadable", path: "/state/last-update-check" }, NOW)).toBe(true);
  });

  test("is due only once a check began more than a day ago, whatever it found", () => {
    const at = (iso: string) => new Date(iso);
    expect(
      checkIsDue(
        {
          kind: "failed",
          at: at("2026-10-13T12:00:00.000Z"),
          error: {
            kind: "refusal",
            code: "update_failed",
            message: "the update check failed: offline",
            meta: {},
            resolve: "agent-record update",
          },
        },
        NOW,
      ),
    ).toBe(false);
    expect(checkIsDue({ kind: "checking", at: at("2026-10-13T11:59:59.000Z") }, NOW)).toBe(true);
    expect(checkIsDue({ kind: "current", at: at("2026-10-14T06:00:00.000Z"), latest: "0.1.0" }, NOW)).toBe(
      false,
    );
  });
});
