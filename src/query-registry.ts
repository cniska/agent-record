import { beforeAfter } from "./query-before-after";
import type { Query } from "./query-contract";
import { priorArt } from "./query-prior-art";
import { search } from "./query-search";
import { signal } from "./query-signal";
import { signalEvents } from "./query-signal-events";
import { thread } from "./query-thread";
import { trace } from "./query-trace";

export const QUERIES: readonly Query[] = [priorArt, search, thread, trace, signal, signalEvents, beforeAfter];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}
