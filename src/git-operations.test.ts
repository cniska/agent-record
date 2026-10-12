import { describe, expect, test } from "bun:test";
import { gitSubcommands } from "./git-operations";

describe("reading git out of a shell command", () => {
  test("names the subcommand", () => {
    expect(gitSubcommands("git status --short")).toEqual(["status"]);
    expect(gitSubcommands("git log --oneline -3")).toEqual(["log"]);
  });

  test("names every subcommand a chained call runs, in order", () => {
    expect(gitSubcommands('git add -A && git commit -m "feat: a thing"')).toEqual(["add", "commit"]);
    expect(gitSubcommands("git fetch; git rebase origin/main || git rebase --abort")).toEqual([
      "fetch",
      "rebase",
      "rebase",
    ]);
  });

  test("reads git through a path, an env assignment or sudo", () => {
    expect(gitSubcommands("/usr/bin/git rev-parse HEAD")).toEqual(["rev-parse"]);
    expect(gitSubcommands("GIT_EDITOR=true git rebase --continue")).toEqual(["rebase"]);
  });

  test("skips the global flags that carry a value", () => {
    expect(gitSubcommands("git -C /tmp/repo status")).toEqual(["status"]);
    expect(gitSubcommands("git -c user.name=T commit -m x")).toEqual(["commit"]);
    expect(gitSubcommands("git --no-pager diff")).toEqual(["diff"]);
  });

  test("ignores git named as anything but the command", () => {
    expect(gitSubcommands("grep -r x --exclude-dir=.git .")).toEqual([]);
    expect(gitSubcommands("ls -la .git/hooks")).toEqual([]);
    expect(gitSubcommands("echo 'run git status'")).toEqual([]);
    expect(gitSubcommands("gh pr view 106 --json state")).toEqual([]);
  });

  test("reports nothing rather than a guess when no subcommand follows", () => {
    expect(gitSubcommands("git")).toEqual([]);
    expect(gitSubcommands("git --version")).toEqual([]);
  });

  test("finds git after another command in the same line", () => {
    expect(gitSubcommands("cd api && git status --porcelain")).toEqual(["status"]);
    expect(gitSubcommands("mise run verify 2>&1 | tail -2 && /usr/bin/git add -A")).toEqual(["add"]);
  });

  test("reads a separator inside quotes as text, not as a new command", () => {
    expect(gitSubcommands('echo "x; git push"')).toEqual([]);
    expect(gitSubcommands("echo 'a | git push'")).toEqual([]);
    expect(gitSubcommands('git commit -m "x && git push --force"')).toEqual(["commit"]);
  });

  test("reads a quoted word with spaces as one word", () => {
    expect(gitSubcommands('"/opt/my tools/git" status')).toEqual(["status"]);
    expect(gitSubcommands('git -C "/tmp/my repo" status')).toEqual(["status"]);
    expect(gitSubcommands("git -c 'user.name=A B' commit -m x")).toEqual(["commit"]);
  });

  test("reads a heredoc body as text and finds the commands after it", () => {
    expect(gitSubcommands("cat > notes.md <<'EOF'\nrun git push; it's fine\nEOF\ngit status")).toEqual([
      "status",
    ]);
    expect(gitSubcommands('python3 - <<PY\nprint("git log")\nPY\n/usr/bin/git add -A')).toEqual(["add"]);
    expect(gitSubcommands("cat <<-EOF\n\tgit push\n\tEOF\ngit diff")).toEqual(["diff"]);
    expect(gitSubcommands("cat<<EOF\ngit push\nEOF")).toEqual([]);
    expect(gitSubcommands('git commit -F - <<EOF && git push\nfix: a "b\nEOF')).toEqual(["commit", "push"]);
  });

  test("reads a here-string as a word, not a heredoc", () => {
    expect(gitSubcommands('cat <<< "git push"\ngit status')).toEqual(["status"]);
  });

  test("reads a comment as text to the end of its line", () => {
    expect(gitSubcommands("# what's staged\ngit diff --cached")).toEqual(["diff"]);
    expect(gitSubcommands("git status # it's quick")).toEqual(["status"]);
    expect(gitSubcommands("git log a#b")).toEqual(["log"]);
  });

  test("joins a line continued with a backslash", () => {
    expect(gitSubcommands("git -C /repo \\\n  status")).toEqual(["status"]);
    expect(gitSubcommands('git -C "/my \\\nrepo" status')).toEqual(["status"]);
  });

  test("reads a command cut off inside a quote up to where it ends", () => {
    expect(gitSubcommands('git commit -m "cut off; git push')).toEqual(["commit"]);
  });
});
