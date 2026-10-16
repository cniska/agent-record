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

  test("redacts secret-shaped strings", () => {
    const leaks = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-123456789012-abcdefghijkl",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const leak of leaks)
      expect(errorTextOf(`failed with ${leak} in it`)).toBe("failed with [REDACTED] in it");
    expect(errorTextOf("Authorization: Bearer abcdef0123456789abcdef")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(errorTextOf("GITHUB_TOKEN=abc123def456ghi789 npm publish")).toBe(
      "GITHUB_TOKEN=[REDACTED] npm publish",
    );
    expect(errorTextOf('{"password": "correct-horse-battery"}')).toBe('{"password": "[REDACTED]"}');
    expect(
      errorTextOf("key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\ndone"),
    ).toBe("key:\n[REDACTED]\ndone");
  });

  test("redacts before cutting, so no part of a long secret is kept", () => {
    const secret = `sk-ant-api03-${"s".repeat(3000)}`;
    const kept = errorTextOf(`${"a".repeat(1000)} ${secret} ${"z".repeat(2000)}`);
    expect(kept).not.toContain("sk-ant");
    expect(kept).not.toContain("s");
  });

  test("leaves text that only looks like a key name alone", () => {
    expect(errorTextOf("error: password is required")).toBe("error: password is required");
    expect(errorTextOf("token: short")).toBe("token: short");
  });

  test("keeps no empty result", () => {
    expect(errorTextOf("")).toBeNull();
  });
});
