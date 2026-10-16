import type { Fixture } from "./cli";

export const CLAUDE: Fixture = "claude/-Users-x-code-demo/claude-session.jsonl";
export const LONG: Fixture = "claude/-Users-x-code-demo/long-session.jsonl";
export const ORPHAN: Fixture = "claude/-Users-x-code-demo/gone-parent/subagents/agent-orphan.jsonl";
export const CODEX_THREAD = "0199a000-0000-7000-8000-000000000001";
export const CODEX_ROLLOUT = `rollout-2026-09-16T10-00-00-${CODEX_THREAD}.jsonl`;
export const CODEX: Fixture = `codex/sessions/2026/09/16/${CODEX_ROLLOUT}`;
export const CODEX_OVERCACHED: Fixture =
  "codex/sessions/2026/09/16/rollout-2026-09-16T11-00-00-0199a000-0000-7000-8000-000000000002.jsonl";
export const GROK: Fixture = "grok/-Users-x-code-demo/grok-session";
export const GROK_UPDATES: Fixture = "grok/-Users-x-code-demo/grok-session/updates.jsonl";
export const PI: Fixture = "pi/--Users-x-code-demo--/2026-09-16T10-00-00-000Z_pi-session.jsonl";
export const OMP: Fixture = "omp/--Users-x-code-demo--/2026-09-16T10-00-00-000Z_omp-session.jsonl";
export const REPO_SESSION: Fixture = "claude/-repo/repo-session.jsonl";
export const TEMP_REPO_SESSION: Fixture = "claude/-temp-repo/temp-repo-session.jsonl";
export const WORKTREE_SESSION: Fixture = "claude/-repo-worktree/worktree-session.jsonl";
export const CODEX_COLUMNS: Fixture =
  "codex/sessions/2026/09/16/rollout-2026-09-16T11-30-00-0199a000-0000-7000-8000-000000000003.jsonl";
export const GROK_COLUMNS: Fixture = "grok/-Users-x-code-demo/grok-columns";
export const PI_COLUMNS: Fixture = "pi/--Users-x-code-demo--/2026-09-16T11-00-00-000Z_pi-columns.jsonl";
export const OMP_COLUMNS: Fixture = "omp/--Users-x-code-demo--/2026-09-16T11-00-00-000Z_omp-columns.jsonl";
