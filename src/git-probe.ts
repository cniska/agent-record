import { statSync } from "node:fs";
import { dirname } from "node:path";
import { git, refused } from "./git";
import { refuseGit } from "./git-contract";

export type Checkout = {
  readonly path: string;
  readonly repo: string;
  readonly head: string | null;
  readonly indexStat: string | null;
};

const PROBE = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--git-common-dir",
  "--git-path",
  "index",
  "--verify",
  "-q",
  "HEAD^{commit}",
];

const LINES_WITH_HEAD = 4;
const LINES_UNBORN = 3;

export function probeCheckout(dir: string): Checkout {
  const run = git(dir, PROBE);
  if (run.status !== 0 && run.status !== 1) throw refused(dir, PROBE, run);
  const lines = run.out.trimEnd().split("\n");
  const [path, commonDir, index, head = null] = lines;
  if (lines.length !== (run.status === 0 ? LINES_WITH_HEAD : LINES_UNBORN) || !path || !commonDir || !index) {
    throw refuseGit("git_output_malformed", {
      command: `git ${PROBE.join(" ")}`,
      problem: "something other than a toplevel, a common dir, an index path and the head when there is one",
    });
  }
  return { path, repo: dirname(commonDir), head, indexStat: statOf(index) };
}

function statOf(path: string): string | null {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : `${stat.size}:${stat.mtimeNs}`;
}
