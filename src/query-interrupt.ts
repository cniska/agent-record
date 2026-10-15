export const CAUSES = ["stop", "permission", "answer", "correct", "unblock"] as const;

export type Cause = (typeof CAUSES)[number];

export type Said =
  | { readonly kind: "interrupt"; readonly cause: Cause }
  | { readonly kind: "task" }
  | { readonly kind: "within" }
  | { readonly kind: "command" };

export const AGENT_TAIL_CHARS = 300;

const SHORT_CHARS = 80;

export const INTERRUPTED = "[Request interrupted by user";

const COMMAND = /^<(?:command-|local-command|bash-)/;

const PUSH_BACK =
  /^(?:no|don'?t|do not|stop|wait|actually|instead|why|not|wrong|undo|revert|but|isn'?t|shouldn'?t)\b/i;

const GO_AHEAD =
  /^(?:yes|yep|yeah|ok|okay|sure|go ahead|proceed|continue|approved?|lgtm|do it|ship it|push|commit)\b/i;

const QUESTION = "?";

const interrupt = (cause: Cause): Said => ({ kind: "interrupt", cause });

export function classify(text: string, agentBefore: string | null, midTurn: boolean): Said {
  const said = text.trim();
  const unexplained: Said = midTurn ? { kind: "within" } : { kind: "task" };
  if (said.startsWith(INTERRUPTED)) return interrupt("stop");
  if (COMMAND.test(said)) return { kind: "command" };
  if (agentBefore === null) return unexplained;
  if (agentBefore.slice(-AGENT_TAIL_CHARS).includes(QUESTION)) return interrupt("answer");
  if (PUSH_BACK.test(said)) return interrupt("correct");
  if (said.length < SHORT_CHARS && GO_AHEAD.test(said)) return interrupt("unblock");
  return unexplained;
}
