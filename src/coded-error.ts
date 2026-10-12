import { z } from "zod";

const ErrorKind = z.enum(["refusal", "fault"]);
export type ErrorKind = z.infer<typeof ErrorKind>;

export const BUG =
  "stop and hand this error to the owner as a bug in agent-record; no command you run resolves it";

type CodedErrorOptions<Meta extends object> = {
  readonly meta: Meta;
  readonly resolve: string;
  readonly kind: ErrorKind;
  readonly cause?: unknown;
};

export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";
  readonly code: Code;
  readonly meta: Meta;
  readonly resolve: string;
  readonly kind: ErrorKind;

  constructor(code: Code, message: string, { meta, resolve, kind, cause }: CodedErrorOptions<Meta>) {
    super(message, { cause });
    this.code = code;
    this.meta = meta;
    this.resolve = resolve;
    this.kind = kind;
  }
}

export const ErrorRecord = z
  .strictObject({
    kind: ErrorKind,
    code: z.string(),
    message: z.string(),
    meta: z.record(z.string(), z.unknown()),
    resolve: z.string(),
  })
  .readonly();
export type ErrorRecord = z.infer<typeof ErrorRecord>;

export function errorRecord({ kind, code, message, meta, resolve }: CodedError): ErrorRecord {
  return { kind, code, message, meta: { ...meta }, resolve };
}

export function isRefusal(error: unknown): error is CodedError {
  return error instanceof CodedError && error.kind === "refusal";
}

export type ErrorTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

function coder(kind: ErrorKind) {
  return <Metas extends Record<string, object>>(table: ErrorTable<Metas>) =>
    <Code extends keyof Metas & string>(
      code: Code,
      meta: Metas[Code],
      cause?: unknown,
    ): CodedError<Code, Metas[Code]> =>
      new CodedError(code, table[code].message(meta), {
        meta,
        resolve: table[code].resolve(meta),
        kind,
        cause,
      });
}

export const refuser = coder("refusal");

export const faulter = coder("fault");

const faultUnexpected = faulter<{ readonly command_failed: { readonly detail: string } }>({
  command_failed: {
    message: ({ detail }) => `the command failed unexpectedly: ${detail}`,
    resolve: () => BUG,
  },
});

export function codedOf(error: unknown): CodedError {
  if (error instanceof CodedError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return faultUnexpected("command_failed", { detail }, error);
}
