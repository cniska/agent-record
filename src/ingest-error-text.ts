import { nonEmpty } from "./ingest-parse";
import { maskSecrets } from "./ingest-secrets";

const KEPT_END_BYTES = 2048;
const WHOLE_BYTES = 2 * KEPT_END_BYTES;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BYTE = 0x80;

function isContinuation(bytes: Buffer, at: number): boolean {
  const byte = bytes[at];
  return byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_BYTE;
}

function headEnd(bytes: Buffer): number {
  let end = KEPT_END_BYTES;
  while (end > 0 && isContinuation(bytes, end)) end--;
  return end;
}

function tailStart(bytes: Buffer): number {
  let start = bytes.length - KEPT_END_BYTES;
  while (start < bytes.length && isContinuation(bytes, start)) start++;
  return start;
}

export function errorTextOf(result: string): string | null {
  const text = nonEmpty(maskSecrets(result));
  if (text === null) return null;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= WHOLE_BYTES) return text;
  const end = headEnd(bytes);
  const start = tailStart(bytes);
  const head = bytes.subarray(0, end).toString("utf8");
  const tail = bytes.subarray(start).toString("utf8");
  return `${head}\n... [${start - end} bytes cut] ...\n${tail}`;
}
