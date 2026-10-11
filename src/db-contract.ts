import { refuser } from "./coded-error";

export const refuseRecord = refuser<{
  readonly record_version: { readonly found: number; readonly expected: number };
  readonly no_database: { readonly path: string };
  readonly lock_held: { readonly path: string; readonly pid: number };
}>({
  record_version: {
    message: ({ found, expected }) =>
      found > expected
        ? `the record is schema version ${found}, newer than the version ${expected} this agent-record reads`
        : `the record is schema version ${found} and this agent-record reads version ${expected}; run \`agent-record rebuild\``,
    resolve: ({ found, expected }) =>
      found > expected ? `run an agent-record that reads schema version ${found}` : "agent-record rebuild",
  },
  no_database: {
    message: ({ path }) => `no database at ${path}; run \`agent-record sync\` first`,
    resolve: () => "agent-record sync",
  },
  lock_held: {
    message: ({ path, pid }) =>
      `another agent-record run holds ${path} (pid ${pid}); run this again once it ends`,
    resolve: ({ pid }) => `run this again once process ${pid} has ended`,
  },
});
