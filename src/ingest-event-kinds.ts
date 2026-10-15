import { z } from "zod";

export const HOOK_EVENTS = ["gate", "verdict", "permission_prompt", "permission_denied", "tag"] as const;

export const GATES = ["commit", "verdict"] as const;

export const DECISIONS = ["allow", "deny"] as const;

export const VERDICTS = ["accept", "return"] as const;

export const FINDING_KINDS = ["critical", "major", "minor", "fix", "consider", "unrated"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type Gate = (typeof GATES)[number];

export type Decision = (typeof DECISIONS)[number];

export type Verdict = (typeof VERDICTS)[number];

const MOST_COUNTED = 1000;

const count = z.number().int().nonnegative().max(MOST_COUNTED);

export const Counted = z.object({
  findings: z.record(z.enum(FINDING_KINDS), count),
  conflicts: count,
  rules: z.array(z.string().min(1)),
});

export type Counted = z.output<typeof Counted>;
