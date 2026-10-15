import { dirname, join } from "node:path";
import type { Env } from "./env";
import { archiveDir } from "./paths";

export const EVENT_LOGS = ["*/events.jsonl"] as const;

export const ARCHIVED_EVENT_LOGS = [...EVENT_LOGS, "*/events-*.jsonl"] as const;

export function segmentOf(copy: string, taken: (path: string) => boolean): string {
  for (let n = 1; ; n++) {
    const segment = join(dirname(copy), `events-${n}.jsonl`);
    if (!taken(segment)) return segment;
  }
}

export function eventArchiveRoot(env: Env): string {
  return join(archiveDir(env), "plugin-data");
}
