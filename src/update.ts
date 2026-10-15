import { rmSync } from "node:fs";
import type { Runtime } from "./cli-contract";
import { errorRecord, isRefusal } from "./coded-error";
import { withUpdateLock } from "./db-lock";
import { stagedBuildsDir } from "./paths";
import { refuseUpdate, type UpdateSource } from "./update-contract";
import { latestRelease, platformTarget, withDownloadedBinary } from "./update-fetch";
import { pruneStaged, stageBuild } from "./update-stage";
import {
  checkIsDue,
  isWanted,
  readRejected,
  readUpdateStamp,
  stagedBuilds,
  type UpdateCheck,
  writeRejected,
  writeUpdateStamp,
} from "./update-state";

type UpdateMode = "now" | "staged";

type Checked = {
  readonly checked: true;
  readonly running: string;
  readonly latest: string;
  readonly staged: string | null;
  readonly pruned: readonly string[];
};

type UpdateReport = Checked | { readonly checked: false; readonly running: string; readonly lastCheck: Date };

type Rollback = { readonly removed: string; readonly rejected: readonly string[]; readonly next: string };

const REBUILD = "agent-record rebuild";

function updateSourceOf(runtime: Runtime): UpdateSource {
  if (runtime.updates === null) throw refuseUpdate("update_from_checkout", {});
  return runtime.updates;
}

async function checked(
  runtime: Runtime,
  source: UpdateSource,
  at: Date,
): Promise<{ stamp: UpdateCheck } & Checked> {
  const { env, version: running } = runtime;
  const release = await latestRelease(source.releasesUrl, platformTarget());
  const { version: latest } = release;
  const wanted = isWanted(latest, running, readRejected(env));
  if (wanted && !stagedBuilds(env).some(({ version }) => version === latest)) {
    await withDownloadedBinary(release, env.tmpDir, (binary) => stageBuild(binary, latest, env));
  }
  const pruned = pruneStaged(running, source.executable, env);
  const stamp: UpdateCheck = wanted ? { kind: "staged", at, latest } : { kind: "current", at, latest };
  return { stamp, checked: true, running, latest, staged: wanted ? latest : null, pruned };
}

export function runUpdate(runtime: Runtime, mode: UpdateMode): Promise<UpdateReport> {
  const source = updateSourceOf(runtime);
  const { env } = runtime;
  if (env.skipUpdate) throw refuseUpdate("update_skipped", {});
  return withUpdateLock(env, async (): Promise<UpdateReport> => {
    const at = runtime.now();
    const last = readUpdateStamp(env);
    if (mode === "staged" && "at" in last && !checkIsDue(last, at)) {
      return { checked: false, running: runtime.version, lastCheck: last.at };
    }
    writeUpdateStamp({ kind: "checking", at }, env);
    try {
      const { stamp, ...report } = await checked(runtime, source, at);
      writeUpdateStamp(stamp, env);
      return report;
    } catch (error) {
      if (isRefusal(error)) writeUpdateStamp({ kind: "failed", at, error: errorRecord(error) }, env);
      throw error;
    }
  });
}

export function rollBack(runtime: Runtime): Rollback {
  updateSourceOf(runtime);
  const { env } = runtime;
  return withUpdateLock(env, () => {
    const [newest] = stagedBuilds(env);
    if (newest === undefined) throw refuseUpdate("nothing_staged", { dir: stagedBuildsDir(env) });
    const rejected = [...new Set([...readRejected(env), newest.version])];
    writeRejected(rejected, env);
    rmSync(newest.dir, { recursive: true, force: true });
    return { removed: newest.version, rejected, next: REBUILD };
  });
}
