import { describe, expect, test } from "bun:test";
import { errorTextOf } from "./ingest-error-text";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

describe("errorTextOf", () => {
  test("keeps a result of 4 KB or less whole", () => {
    const whole = `Exit code 1\n${"x".repeat(4096 - 12)}`;
    expect(bytes(whole)).toBe(4096);
    expect(errorTextOf(whole)).toBe(whole);
  });

  test("keeps the first and last 2 KB of a longer result, naming the bytes cut between", () => {
    const head = `<tool_use_error>InputValidationError: ${"h".repeat(2048)}`;
    const tail = `${"t".repeat(2048)}\nerror: the reason is here`;
    const kept = errorTextOf(`${head}${"m".repeat(5000)}${tail}`);
    expect(kept?.startsWith("<tool_use_error>InputValidationError: ")).toBe(true);
    expect(kept?.endsWith("error: the reason is here")).toBe(true);
    const marker = "\n... [5064 bytes cut] ...\n";
    expect(kept).toContain(marker);
    expect(bytes(kept ?? "")).toBe(2048 + bytes(marker) + 2048);
    expect(kept).not.toContain("m");
  });

  test("never cuts a character in half at either end", () => {
    const kept = errorTextOf(`a${"é".repeat(3000)}b`) ?? "";
    expect(kept).not.toContain("�");
    expect(kept.startsWith("aé")).toBe(true);
    expect(kept.endsWith("éb")).toBe(true);
  });

  test("redacts before cutting, so no part of a long secret is kept", () => {
    const secret = `sk-ant-api03-${"s".repeat(3000)}`;
    const kept = errorTextOf(`${"a".repeat(1000)} ${secret} ${"z".repeat(2000)}`);
    expect(kept).not.toContain("sk-ant");
    expect(kept).not.toContain("s");
  });

  test("keeps no empty result", () => {
    expect(errorTextOf("")).toBeNull();
  });
});
