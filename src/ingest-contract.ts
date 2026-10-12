import { refuser } from "./coded-error";

export const refuseIngest = refuser<{
  readonly source_unreadable: { readonly path: string; readonly detail: string };
  readonly titles_unreadable: { readonly path: string; readonly detail: string };
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
});
