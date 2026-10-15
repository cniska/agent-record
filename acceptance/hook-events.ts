import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Home } from "./cli";

const PLUGIN_DATA = [".claude", "plugins", "data"];

const INSTALL = "acme-kit";

type Fields = Readonly<Record<string, unknown>>;

export type HookLine = Fields & { readonly ts: string; readonly event: string };

export function eventLogPath(home: Home, install: string = INSTALL): string {
  return join(home.root, ...PLUGIN_DATA, install, "events.jsonl");
}

export function archivedEventLog(home: Home, install: string = INSTALL): string {
  return join(home.archive, "plugin-data", install, "events.jsonl");
}

export function withEventLog(
  home: Home,
  session: string,
  lines: readonly (HookLine | string)[],
  install: string = INSTALL,
): Home {
  const path = eventLogPath(home, install);
  mkdirSync(dirname(path), { recursive: true });
  const text = lines
    .map((line) =>
      typeof line === "string"
        ? line
        : JSON.stringify({ v: 1, session, agent: null, cwd: home.root, ...line }),
    )
    .join("\n");
  appendFileSync(path, `${text}\n`);
  return home;
}

export const gate = (
  ts: string,
  fields: Fields & { readonly decision: "allow" | "deny"; readonly reason: string },
): HookLine => ({
  ts,
  event: "gate",
  gate: "commit",
  repo: null,
  head: null,
  fingerprint: null,
  ...fields,
});

export const verdict = (
  ts: string,
  fields: Fields & { readonly verdict: "accept" | "return"; readonly repo: string },
): HookLine => ({ ts, event: "verdict", fingerprint: "f0", ...fields });
