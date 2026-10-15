import { refuser } from "./coded-error";

export type UpdateSource = { readonly releasesUrl: string; readonly executable: string };

const UPDATE = "agent-record update";

export const refuseUpdate = refuser<{
  readonly update_from_checkout: Record<string, never>;
  readonly update_skipped: Record<string, never>;
  readonly no_build_for_platform: { readonly platform: string };
  readonly update_failed: { readonly detail: string };
  readonly build_unrunnable: { readonly version: string; readonly failure: string };
  readonly nothing_staged: { readonly dir: string };
  readonly rejected_unreadable: { readonly path: string; readonly detail: string };
}>({
  update_from_checkout: {
    message: () => "this agent-record runs from a checkout, which updates through git, not from releases",
    resolve: () => "git pull in the checkout, then mise install",
  },
  update_skipped: {
    message: () => "AGENT_RECORD_SKIP_UPDATE=1 turns off every update check and download",
    resolve: () => `unset AGENT_RECORD_SKIP_UPDATE, then ${UPDATE}`,
  },
  no_build_for_platform: {
    message: ({ platform }) => `agent-record releases ship no build for ${platform}`,
    resolve: () => "build agent-record from source with Bun, as its README says",
  },
  update_failed: {
    message: ({ detail }) => `the update check failed: ${detail}`,
    resolve: () => `check that this machine is online and can reach github.com, then ${UPDATE}`,
  },
  build_unrunnable: {
    message: ({ version, failure }) => `the downloaded ${version} build ${failure}, so it is not staged`,
    resolve: () => `keep running this build; ${UPDATE} stages the next release once one is published`,
  },
  nothing_staged: {
    message: ({ dir }) => `no update is staged in ${dir}, so there is nothing to roll back`,
    resolve: () => "agent-record doctor",
  },
  rejected_unreadable: {
    message: ({ path, detail }) => `${path} holds no list of rejected versions: ${detail}`,
    resolve: ({ path }) => `remove ${path}, then roll back again any release you reject`,
  },
});
