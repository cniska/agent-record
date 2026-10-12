import { BUG, faulter, refuser } from "./coded-error";

export type Failure = (path: string, error: unknown) => void;

export const refuseIngest = refuser<{
  readonly source_unreadable: { readonly path: string; readonly detail: string };
  readonly titles_unreadable: { readonly path: string; readonly detail: string };
  readonly sidecar_unreadable: { readonly path: string; readonly detail: string };
}>({
  source_unreadable: {
    message: ({ path, detail }) => `cannot read ${path}: ${detail}`,
    resolve: ({ path }) => `make ${path} readable or move it aside, then run agent-record sync`,
  },
  titles_unreadable: {
    message: ({ path, detail }) =>
      `cannot read Codex thread titles from ${path}: ${detail}; its sessions are recorded untitled`,
    resolve: ({ path }) =>
      `if ${path} is unreadable, make it readable and run agent-record sync; if the detail names a missing table or column, Codex changed its thread store: hand this to the owner to update agent-record, and leave the file in place`,
  },
  sidecar_unreadable: {
    message: ({ path, detail }) => `cannot read ${path}: ${detail}; its session is recorded without it`,
    resolve: ({ path }) =>
      `if ${path} is unreadable, make it readable and run agent-record sync; if the detail names a field or a JSON error, the tool changed its format: hand this to the owner to update agent-record, and leave the file in place`,
  },
});

export const faultIngest = faulter<{
  readonly cursor_state_corrupt: { readonly thread: string; readonly state: string; readonly detail: string };
}>({
  cursor_state_corrupt: {
    message: ({ thread, detail }) =>
      `the cursor state agent-record kept for Codex thread ${thread} is corrupt: ${detail}`,
    resolve: () => BUG,
  },
});
