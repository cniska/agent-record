# agent-record

A local record of coding-agent sessions and the queries over it. [`SPEC.md`](SPEC.md) states what must hold and changes in the same commit as the behavior it describes; [`docs/commands.md`](docs/commands.md) lists the commands; [`src/README.md`](src/README.md) maps the modules.

## Rules

- `bun run check` is the check: lint, typecheck, knip (unused exports, files and dependencies) and tests. It passes before every commit.
- The record carries one schema version as `PRAGMA user_version` (`src/db-schema.ts`). A change to the tables, or to what a stored value means, bumps it; `sync` rebuilds an older record under its lock, every other reader and writer refuses an older version naming the next sync or `agent-record rebuild` as the repair, and every command but `rebuild` refuses a newer one.
- Ingest reads only the archive (`src/ingest-archive.ts`), never a tool's own files, so `rebuild` loses nothing a tool has since deleted.
- A change to a per-call or per-event column, a column of `message`, `usage`, `turn`, `tool_call`, `git_command`, `skill_load` or `compaction`, decides it for every source the record reads (Claude Code, Codex, Grok, pi and omp): each source fills it, or `SPEC.md` names the source left out and why. `acceptance/sources.acceptance.ts` (AC-74) holds each column to the sources that fill it, so the change updates that table for every source.
- A module reaches another only through its contract, its commands and the files `src/modules.test.ts` publishes; publish a file there, or move it, rather than reach past it.
- This repo requires no other cniska tool, and names none of them, nor any of their skills, agents, plugin installs or report shapes, in src, SPEC, README, docs, plugin or tests; the one exception is [`docs/development.md`](docs/development.md), which may suggest cniska-skills. A workflow that wants a grouping writes a `tag` line. `scripts/standalone.test.ts`, in the check, refuses the names it knows.
- Fix the cause, never work around it, and add no debt.
- A bug fix lands with a test watched failing first.
- No test waits real time: a wait or a clock is passed in, as `now` is.
- Code carries no comments. `.githooks/pre-commit.d/no-comments` refuses a comment a commit adds, other than a directive a tool reads. A why goes into a name, a test, or this file.
- Work each task on a topic branch in its own worktree. Commit each slice there once `bun run check` passes and a fresh reviewer accepts it, and push the branch after each. `.githooks/commit-msg` judges the message: one Conventional Commit subject, ASCII, at most 50 characters, and no body.
- Land a task as a whole, with no pull request: once a fresh reviewer, given the branch's whole diff against `main`, accepts it (for a one-commit branch, that commit's accept), fast-forward `main` to the branch, push `main` and delete the branch on origin. That accept is the owner's standing sign-off, so no landing waits on them. A release is not a task: its tag, and any commit `scripts/release.sh` makes, stay on `main`. The first release (v0.1.0) is cut by hand, as [`docs/releasing.md`](docs/releasing.md) "The first release" says, and every later one goes through `scripts/release.sh <patch|minor|major>`, run by `cniska-skills:ship`.
