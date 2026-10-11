export type ErrorKind = "refusal" | "fault";

export const BUG =
  "stop and hand this error to the owner as a bug in agent-record; no command you run resolves it";

export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";

  constructor(
    readonly code: Code,
    message: string,
    readonly meta: Meta,
    readonly resolve: string,
    readonly kind: ErrorKind,
  ) {
    super(message);
  }
}

export function isRefusal(error: unknown): error is CodedError {
  return error instanceof CodedError && error.kind === "refusal";
}

export type RefusalRecord = {
  readonly code: string;
  readonly message: string;
  readonly meta: Record<string, unknown>;
  readonly resolve: string;
};

export function recordOf(error: CodedError): RefusalRecord {
  return { code: error.code, message: error.message, meta: { ...error.meta }, resolve: error.resolve };
}

export type ErrorTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

function coder(kind: ErrorKind) {
  return <Metas extends Record<string, object>>(table: ErrorTable<Metas>) =>
    <Code extends keyof Metas & string>(code: Code, meta: Metas[Code]): CodedError<Code, Metas[Code]> =>
      new CodedError(code, table[code].message(meta), meta, table[code].resolve(meta), kind);
}

export const refuser = coder("refusal");

export const faulter = coder("fault");
