import { nonEmpty } from "./ingest-parse";

const KEPT_END_BYTES = 2048;
const WHOLE_BYTES = 2 * KEPT_END_BYTES;
const REDACTED = "[REDACTED]";
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BYTE = 0x80;

const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

const NAMED_SECRET =
  /(\b[\w-]*?(?:api[_-]?key|secret|token|password|passwd)["']?\s*[=:]\s*["']?)[^\s"'`,;&]{8,}/gi;

function redacted(text: string): string {
  const shaped = SECRET_SHAPES.reduce((kept, shape) => kept.replace(shape, REDACTED), text);
  return shaped.replace(BEARER, `$1${REDACTED}`).replace(NAMED_SECRET, `$1${REDACTED}`);
}

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
  const text = nonEmpty(redacted(result));
  if (text === null) return null;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= WHOLE_BYTES) return text;
  const end = headEnd(bytes);
  const start = tailStart(bytes);
  const head = bytes.subarray(0, end).toString("utf8");
  const tail = bytes.subarray(start).toString("utf8");
  return `${head}\n... [${start - end} bytes cut] ...\n${tail}`;
}
