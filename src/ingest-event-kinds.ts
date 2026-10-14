export const HOOK_EVENTS = ["gate", "verdict", "permission_prompt", "permission_denied"] as const;

export const GATES = ["commit", "verdict"] as const;

export const DECISIONS = ["allow", "deny"] as const;

export const VERDICTS = ["accept", "return"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
