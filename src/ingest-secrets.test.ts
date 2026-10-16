import { describe, expect, test } from "bun:test";
import { maskSecrets } from "./ingest-secrets";

describe("maskSecrets", () => {
  test("replaces secret-shaped strings with [REDACTED]", () => {
    const leaks = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-123456789012-abcdefghijkl",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const leak of leaks)
      expect(maskSecrets(`failed with ${leak} in it`)).toBe("failed with [REDACTED] in it");
    expect(maskSecrets("Authorization: Bearer abcdef0123456789abcdef")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(maskSecrets("GITHUB_TOKEN=abc123def456ghi789 npm publish")).toBe(
      "GITHUB_TOKEN=[REDACTED] npm publish",
    );
    expect(maskSecrets('{"password": "correct-horse-battery"}')).toBe('{"password": "[REDACTED]"}');
    expect(
      maskSecrets("key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\ndone"),
    ).toBe("key:\n[REDACTED]\ndone");
  });

  test("masks any value given to an environment name ending in _TOKEN or _SECRET, however short", () => {
    expect(maskSecrets("CLAUDE_CODE_MESSAGING_TOKEN=0123456789abcdef bun run x")).toBe(
      "CLAUDE_CODE_MESSAGING_TOKEN=[REDACTED] bun run x",
    );
    expect(maskSecrets("export NPM_SECRET=abc; X_TOKEN='q1' Y_TOKEN=\"q2\"")).toBe(
      "export NPM_SECRET=[REDACTED]; X_TOKEN='[REDACTED]' Y_TOKEN=\"[REDACTED]\"",
    );
  });

  test("keeps the shell around a masked value, so its git runs still parse", () => {
    expect(maskSecrets('X_TOKEN=abc&&git push; Y_SECRET="a b" git -C /r commit')).toBe(
      'X_TOKEN=[REDACTED]&&git push; Y_SECRET="[REDACTED]" git -C /r commit',
    );
  });

  test("leaves text that only looks like a key name alone", () => {
    expect(maskSecrets("error: password is required")).toBe("error: password is required");
    expect(maskSecrets("token: short")).toBe("token: short");
    expect(maskSecrets("MY_TOKEN= is unset")).toBe("MY_TOKEN= is unset");
    expect(maskSecrets("the_token=abc")).toBe("the_token=abc");
  });
});
