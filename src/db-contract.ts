import { refuser } from "./coded-error";

export const refuseRecord = refuser<{
  readonly record_version: { readonly found: number; readonly expected: number };
  readonly no_database: { readonly path: string };
  readonly record_unopenable: { readonly path: string };
  readonly lock_held: { readonly path: string; readonly pid: number };
  readonly record_busy: { readonly path: string };
  readonly lock_contended: { readonly path: string };
  readonly lock_unreadable: { readonly path: string; readonly detail: string };
}>({
  record_version: {
    message: ({ found, expected }) =>
      found > expected
        ? `the record is schema version ${found}, newer than the version ${expected} this agent-record reads`
        : `the record is schema version ${found} and this agent-record reads version ${expected}; the next \`agent-record sync\` rebuilds it, or run \`agent-record rebuild\``,
    resolve: ({ found, expected }) =>
      found > expected
        ? `run an agent-record that reads schema version ${found}`
        : "the next agent-record sync rebuilds it, or run agent-record rebuild",
  },
  no_database: {
    message: ({ path }) => `no database at ${path}; run \`agent-record sync\` first`,
    resolve: () => "agent-record sync",
  },
  record_unopenable: {
    message: ({ path }) => `SQLite cannot open ${path} as the record`,
    resolve: ({ path }) =>
      `make ${path} a file you can read and write, or move it aside and run \`agent-record rebuild\``,
  },
  lock_held: {
    message: ({ path, pid }) =>
      `another agent-record run holds ${path} (pid ${pid}); run this again once it ends`,
    resolve: ({ pid }) => `run this again once process ${pid} has ended`,
  },
  record_busy: {
    message: ({ path }) => `another process holds ${path}, or SQLite is recovering it after a crash`,
    resolve: () => "run this again; if it keeps failing, close whatever holds the file",
  },
  lock_contended: {
    message: ({ path }) => `another agent-record run is taking ${path}`,
    resolve: () => "run this again once the other agent-record run ends",
  },
  lock_unreadable: {
    message: ({ path, detail }) => `cannot read which process holds ${path}: ${detail}`,
    resolve: ({ path }) => `remove ${path} if no agent-record is running`,
  },
});
