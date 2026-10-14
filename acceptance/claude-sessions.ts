import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Home } from "./cli";

export type Step =
  | { readonly owner: string; readonly at: string }
  | { readonly agent: string; readonly at: string }
  | { readonly bash: string; readonly at: string; readonly done: string }
  | { readonly read: string; readonly at: string }
  | { readonly rejected: string; readonly at: string };

export type Subagent = { readonly id: string; readonly agentType: string; readonly steps: readonly Step[] };

export type ClaudeSession = {
  readonly id: string;
  readonly cwd: string;
  readonly steps: readonly Step[];
  readonly subagents?: readonly Subagent[];
};

const PROJECTS = [".claude", "projects"];

function linesOf(sessionId: string, cwd: string, steps: readonly Step[], prefix: string): string {
  const sidechain = prefix !== sessionId;
  const base = { sessionId, cwd, version: "2.1.260", entrypoint: "cli", isSidechain: sidechain };
  const lines = steps.flatMap((step, index): readonly object[] => {
    const uuid = `${prefix}-${index}`;
    const assistant = (at: string, content: readonly unknown[]) => ({
      ...base,
      type: "assistant",
      uuid,
      timestamp: at,
      requestId: `${uuid}-req`,
      message: { id: `${uuid}-msg`, model: "claude-opus-5", content },
    });
    const result = (at: string, tool: string, more: Record<string, unknown> = {}) => ({
      ...base,
      type: "user",
      uuid: `${uuid}-result`,
      timestamp: at,
      ...more,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] },
    });
    const tool = `${uuid}-tool`;
    if ("owner" in step) {
      return [
        {
          ...base,
          type: "user",
          uuid,
          timestamp: step.at,
          promptSource: "typed",
          message: { role: "user", content: step.owner },
        },
      ];
    }
    if ("agent" in step) return [assistant(step.at, [{ type: "text", text: step.agent }])];
    if ("bash" in step) {
      return [
        assistant(step.at, [{ type: "tool_use", id: tool, name: "Bash", input: { command: step.bash } }]),
        result(step.done, tool),
      ];
    }
    if ("read" in step) {
      return [
        assistant(step.at, [{ type: "tool_use", id: tool, name: "Read", input: { file_path: step.read } }]),
        result(step.at, tool),
      ];
    }
    return [
      assistant(step.at, [{ type: "tool_use", id: tool, name: "Bash", input: { command: step.rejected } }]),
      result(step.at, tool, { toolDenialKind: "user-rejected" }),
    ];
  });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

export function withClaudeSessions(home: Home, sessions: readonly ClaudeSession[]): Home {
  for (const { id, cwd, steps, subagents = [] } of sessions) {
    const project = join(home.root, ...PROJECTS, cwd.replaceAll("/", "-"));
    mkdirSync(join(project, id, "subagents"), { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), linesOf(id, cwd, steps, id));
    for (const sub of subagents) {
      const path = join(project, id, "subagents", `agent-${sub.id}`);
      writeFileSync(`${path}.jsonl`, linesOf(id, cwd, sub.steps, `${id}-${sub.id}`));
      writeFileSync(`${path}.meta.json`, JSON.stringify({ agentType: sub.agentType }));
    }
  }
  return home;
}
