import type { Query } from "./query-contract";
import { priorArt } from "./query-prior-art";
import { search } from "./query-search";
import { thread } from "./query-thread";

export const QUERIES: readonly Query[] = [priorArt, search, thread];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}
