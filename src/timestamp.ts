import { z } from "zod";

export const StampAt = z.iso.datetime().transform((at) => new Date(at));

export const MINUTE_MS = 60_000;

export const HOUR_MS = 60 * MINUTE_MS;

export const DAY_MS = 24 * HOUR_MS;

export const EpochMs = z
  .number()
  .transform((ms, context) => {
    const date = new Date(ms);
    if (Number.isFinite(date.getTime())) return date.toISOString();
    context.addIssue({ code: "custom", message: "not a time" });
    return z.NEVER;
  })
  .brand<"Timestamp">();

export type Timestamp = z.output<typeof EpochMs>;

export const EpochSeconds = z
  .number()
  .transform((seconds) => seconds * 1000)
  .pipe(EpochMs);

export const Timestamp = z.iso.datetime({ offset: true }).transform(Date.parse).pipe(EpochMs);

export const ArgumentTimestamp = z
  .union([z.iso.datetime({ offset: true }), z.iso.datetime({ offset: true, precision: -1 })])
  .transform(Date.parse)
  .pipe(EpochMs);

export function timestampMinus(time: Timestamp, ms: number): Timestamp | null {
  const shifted = EpochMs.safeParse(Date.parse(time) - ms);
  return shifted.success ? shifted.data : null;
}
