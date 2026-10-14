import { describe, expect, test } from "bun:test";
import { isNewer } from "./update-version";

describe("isNewer", () => {
  test("orders each field numerically, not as text", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
  });

  test("finds an equal or older version not newer", () => {
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  });

  test("finds a version it cannot order not newer", () => {
    expect(isNewer("0.3.0-beta", "0.2.0")).toBe(false);
    expect(isNewer("0.3.0", "dev")).toBe(false);
  });
});
