import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "git-fixtures.test-support.ts");
const SIGNING_FAILS = "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Scratch = { readonly root: string; readonly home: string; readonly fixtureRoot: string };

function scratch(): Scratch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-record-git-test-env-")));
  roots.push(root);
  const home = join(root, "home");
  const fixtureRoot = join(root, "fixture");
  mkdirSync(home);
  mkdirSync(fixtureRoot);
  return { root, home, fixtureRoot };
}

function runFixtureUnderPreload(at: Scratch, env: Record<string, string>) {
  const probe = join(at.root, "probe.ts");
  writeFileSync(
    probe,
    [
      'import { test } from "bun:test";',
      `import { repoWithWorktree } from ${JSON.stringify(FIXTURE)};`,
      `test("builds the fixture", () => { repoWithWorktree(${JSON.stringify(at.fixtureRoot)}); });`,
    ].join("\n"),
  );
  const ran = Bun.spawnSync([process.execPath, "test", probe], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: at.home, ...env },
  });
  return { exitCode: ran.exitCode, stderr: ran.stderr.toString() };
}

const commitsIn = (repo: string) =>
  Bun.spawnSync(["git", "-C", repo, "rev-list", "--count", "HEAD"]).stdout.toString().trim();

describe("the test preload", () => {
  test("keeps a global commit.gpgsign from reaching a fixture's git", () => {
    const at = scratch();
    writeFileSync(join(at.home, ".gitconfig"), SIGNING_FAILS);

    expect(runFixtureUnderPreload(at, {})).toMatchObject({ exitCode: 0 });
    expect(commitsIn(join(at.fixtureRoot, "repo"))).toBe("2");
  });

  test("keeps a global ignore file under XDG_CONFIG_HOME from hiding a fixture's files", () => {
    const at = scratch();
    const config = join(at.root, "config");
    mkdirSync(join(config, "git"), { recursive: true });
    writeFileSync(join(config, "git", "ignore"), "*.ts\n");

    expect(runFixtureUnderPreload(at, { XDG_CONFIG_HOME: config })).toMatchObject({ exitCode: 0 });
    expect(commitsIn(join(at.fixtureRoot, "repo"))).toBe("2");
  });

  test("keeps a global ignore file under HOME from hiding a fixture's files", () => {
    const at = scratch();
    mkdirSync(join(at.home, ".config", "git"), { recursive: true });
    writeFileSync(join(at.home, ".config", "git", "ignore"), "*.ts\n");

    expect(runFixtureUnderPreload(at, {})).toMatchObject({ exitCode: 0 });
    expect(commitsIn(join(at.fixtureRoot, "repo"))).toBe("2");
  });

  test("drops a GIT_ key it does not name, such as the config a parent git passes down", () => {
    const at = scratch();

    const ran = runFixtureUnderPreload(at, {
      GIT_CONFIG_PARAMETERS: "'commit.gpgsign'='true' 'gpg.program'='false'",
    });

    expect(ran).toMatchObject({ exitCode: 0 });
    expect(commitsIn(join(at.fixtureRoot, "repo"))).toBe("2");
  });

  test("drops a GIT_DIR a hook exports, so a fixture's git acts on its own repo", () => {
    const at = scratch();
    const outer = join(at.root, "outer");
    Bun.spawnSync(["git", "init", "-q", outer]);

    const ran = runFixtureUnderPreload(at, { GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer });

    expect(ran).toMatchObject({ exitCode: 0 });
    expect(commitsIn(join(at.fixtureRoot, "repo"))).toBe("2");
    expect(Bun.spawnSync(["git", "-C", outer, "rev-parse", "--verify", "-q", "HEAD"]).exitCode).not.toBe(0);
  });
});
