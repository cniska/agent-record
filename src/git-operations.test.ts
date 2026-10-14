import { describe, expect, test } from "bun:test";
import { gitRuns } from "./git-operations";

const AT = { cwd: "/w/repo", home: "/h" };

const subcommands = (command: string) => gitRuns(command, AT).map((run) => run.subcommand);

describe("reading git out of a shell command", () => {
  test("names the subcommand", () => {
    expect(subcommands("git status --short")).toEqual(["status"]);
    expect(subcommands("git log --oneline -3")).toEqual(["log"]);
  });

  test("names every subcommand a chained call runs, in order", () => {
    expect(subcommands('git add -A && git commit -m "feat: a thing"')).toEqual(["add", "commit"]);
    expect(subcommands("git fetch; git rebase origin/main || git rebase --abort")).toEqual([
      "fetch",
      "rebase",
      "rebase",
    ]);
  });

  test("reads git through a path, an env assignment or sudo", () => {
    expect(subcommands("/usr/bin/git rev-parse HEAD")).toEqual(["rev-parse"]);
    expect(subcommands("GIT_EDITOR=true git rebase --continue")).toEqual(["rebase"]);
  });

  test("skips the global flags that carry a value", () => {
    expect(subcommands("git -C /tmp/repo status")).toEqual(["status"]);
    expect(subcommands("git -c user.name=T commit -m x")).toEqual(["commit"]);
    expect(subcommands("git --no-pager diff")).toEqual(["diff"]);
  });

  test("ignores git named as anything but the command", () => {
    expect(subcommands("grep -r x --exclude-dir=.git .")).toEqual([]);
    expect(subcommands("ls -la .git/hooks")).toEqual([]);
    expect(subcommands("echo 'run git status'")).toEqual([]);
    expect(subcommands("gh pr view 106 --json state")).toEqual([]);
  });

  test("reports nothing rather than a guess when no subcommand follows", () => {
    expect(subcommands("git")).toEqual([]);
    expect(subcommands("git --version")).toEqual([]);
  });

  test("finds git after another command in the same line", () => {
    expect(subcommands("cd api && git status --porcelain")).toEqual(["status"]);
    expect(subcommands("mise run verify 2>&1 | tail -2 && /usr/bin/git add -A")).toEqual(["add"]);
  });

  test("reads a separator inside quotes as text, not as a new command", () => {
    expect(subcommands('echo "x; git push"')).toEqual([]);
    expect(subcommands("echo 'a | git push'")).toEqual([]);
    expect(subcommands('git commit -m "x && git push --force"')).toEqual(["commit"]);
  });

  test("reads a quoted word with spaces as one word", () => {
    expect(subcommands('"/opt/my tools/git" status')).toEqual(["status"]);
    expect(subcommands('git -C "/tmp/my repo" status')).toEqual(["status"]);
    expect(subcommands("git -c 'user.name=A B' commit -m x")).toEqual(["commit"]);
  });

  test("reads a heredoc body as text and finds the commands after it", () => {
    expect(subcommands("cat > notes.md <<'EOF'\nrun git push; it's fine\nEOF\ngit status")).toEqual([
      "status",
    ]);
    expect(subcommands('python3 - <<PY\nprint("git log")\nPY\n/usr/bin/git add -A')).toEqual(["add"]);
    expect(subcommands("cat <<-EOF\n\tgit push\n\tEOF\ngit diff")).toEqual(["diff"]);
    expect(subcommands("cat<<EOF\ngit push\nEOF")).toEqual([]);
    expect(subcommands('git commit -F - <<EOF && git push\nfix: a "b\nEOF')).toEqual(["commit", "push"]);
  });

  test("reads a here-string as a word, not a heredoc", () => {
    expect(subcommands('cat <<< "git push"\ngit status')).toEqual(["status"]);
  });

  test("reads a comment as text to the end of its line", () => {
    expect(subcommands("# what's staged\ngit diff --cached")).toEqual(["diff"]);
    expect(subcommands("git status # it's quick")).toEqual(["status"]);
    expect(subcommands("git log a#b")).toEqual(["log"]);
  });

  test("joins a line continued with a backslash", () => {
    expect(subcommands("git -C /repo \\\n  status")).toEqual(["status"]);
    expect(subcommands('git -C "/my \\\nrepo" status')).toEqual(["status"]);
  });

  test("reads a command cut off inside a quote up to where it ends", () => {
    expect(subcommands('git commit -m "cut off; git push')).toEqual(["commit"]);
  });
});

describe("reading where each git call in a shell command ran", () => {
  test("runs git in the working directory when nothing moves it", () => {
    expect(gitRuns("git commit -m wip && git push", AT)).toEqual([
      { subcommand: "commit", dir: "/w/repo" },
      { subcommand: "push", dir: "/w/repo" },
    ]);
  });

  test("follows a cd before git, resolving a relative path and the home", () => {
    expect(gitRuns("cd ~/code/ops && git commit -q -m x && git push -q", AT)).toEqual([
      { subcommand: "commit", dir: "/h/code/ops" },
      { subcommand: "push", dir: "/h/code/ops" },
    ]);
    expect(gitRuns("cd sub; git commit -m x", AT)).toEqual([{ subcommand: "commit", dir: "/w/repo/sub" }]);
    expect(gitRuns("cd && git push", AT)).toEqual([{ subcommand: "push", dir: "/h" }]);
    expect(gitRuns('cd "/my repo" && git push', AT)).toEqual([{ subcommand: "push", dir: "/my repo" }]);
  });

  test("reads git -C as the directory of that call alone", () => {
    expect(gitRuns("git -C ../other commit -m x && git push", AT)).toEqual([
      { subcommand: "commit", dir: "/w/other" },
      { subcommand: "push", dir: "/w/repo" },
    ]);
  });

  test("knows no directory when nothing anchors a relative one", () => {
    const unanchored = { cwd: null, home: "/h" };
    expect(gitRuns("git push", unanchored)).toEqual([{ subcommand: "push", dir: null }]);
    expect(gitRuns("cd sub && git push", unanchored)).toEqual([{ subcommand: "push", dir: null }]);
    expect(gitRuns("cd /r && git push", unanchored)).toEqual([{ subcommand: "push", dir: "/r" }]);
  });

  test("skips a command that is not git", () => {
    expect(gitRuns("echo git push && ls", AT)).toEqual([]);
  });
});
