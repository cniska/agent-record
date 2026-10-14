import { beforeAfter } from "./query-before-after";
import type { Query } from "./query-contract";
import { priorArt } from "./query-prior-art";
import { search } from "./query-search";
import { signal } from "./query-signal";
import { signalEvents } from "./query-signal-events";
import { thread } from "./query-thread";

export const QUERIES: readonly Query[] = [priorArt, search, thread, signal, signalEvents, beforeAfter];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}
