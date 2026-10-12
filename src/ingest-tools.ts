export const TOOLS = ["claude", "codex", "grok", "pi", "omp"] as const;

export type Tool = (typeof TOOLS)[number];

export const KINDS = ["transcript", "subagent", "rollout"] as const;

export type Kind = (typeof KINDS)[number];
