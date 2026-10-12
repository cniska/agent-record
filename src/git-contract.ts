import { refuser } from "./coded-error";

export const refuseGit = refuser<{
  readonly git_failed: {
    readonly repo: string;
    readonly command: string;
    readonly status: number;
    readonly detail: string;
  };
  readonly git_unavailable: { readonly command: string; readonly detail: string };
  readonly git_output_malformed: { readonly command: string; readonly problem: string };
}>({
  git_unavailable: {
    message: ({ command, detail }) => `${command} could not start git: ${detail}`,
    resolve: () => "install git or put it on PATH, then check with: git --version",
  },
  git_failed: {
    message: ({ repo, command, status, detail }) =>
      `${command} failed in ${repo} with exit ${status}${detail === "" ? "" : `: ${detail}`}`,
    resolve: ({ repo }) => `git -C ${repo} status`,
  },
  git_output_malformed: {
    message: ({ command, problem }) => `${command} printed ${problem}`,
    resolve: () => "git --version",
  },
});
