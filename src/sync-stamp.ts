import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Runtime } from "./cli-contract";
import { codedOf, ErrorRecord, errorRecord } from "./coded-error";
import type { Env } from "./env";
import { parseJson } from "./ingest-source-read";
import type { SyncReport } from "./ingest-sync";
import { syncStampPath } from "./paths";

const At = z.iso.datetime().transform((at) => new Date(at));

const SyncOutcome = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("finished"),
    at: At,
    failures: z.strictObject({ count: z.int().positive(), first: z.string() }).nullable(),
  }),
  z.strictObject({ kind: z.literal("failed"), at: At, error: ErrorRecord }),
]);
export type SyncOutcome = z.infer<typeof SyncOutcome>;

export type SyncStamp =
  | { readonly kind: "never" }
  | { readonly kind: "unreadable"; readonly path: string }
  | SyncOutcome;

function writeSyncStamp(outcome: SyncOutcome, env: Env): void {
  const path = syncStampPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(outcome)}\n`);
}

export function readSyncStamp(env: Env): SyncStamp {
  const path = syncStampPath(env);
  if (!existsSync(path)) return { kind: "never" };
  const read = parseJson(readFileSync(path, "utf8"), SyncOutcome);
  if (read.kind === "invalid") return { kind: "unreadable", path };
  return read.value;
}

function finishedOf(report: SyncReport, at: Date): SyncOutcome {
  const [first] = report.failures;
  return {
    kind: "finished",
    at,
    failures: first === undefined ? null : { count: report.failures.length, first: first.path },
  };
}

export function stampingOutcome(
  { now, env }: Pick<Runtime, "now" | "env">,
  run: () => SyncReport,
): SyncReport {
  let report: SyncReport;
  try {
    report = run();
  } catch (error) {
    writeSyncStamp({ kind: "failed", at: now(), error: errorRecord(codedOf(error)) }, env);
    throw error;
  }
  writeSyncStamp(finishedOf(report, now()), env);
  return report;
}
