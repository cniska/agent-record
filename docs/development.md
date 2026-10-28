# Development

Setup, checks and layout, for working on this repo.

## Setup

With [mise](https://mise.jdx.dev) installed:

```bash
git clone https://github.com/cniska/agent-record.git
cd agent-record
mise trust && mise install
```

- `mise install` installs actionlint, the dependencies and [Bun](https://bun.sh), which the source runs on, and the `bun install` its postinstall runs calls the `prepare` script, which points `core.hooksPath` at `.githooks/`. Only in the clone, never in a worktree, does it link `agent-record` into `~/.bun/bin`, so removing a worktree never leaves the command pointing at a deleted checkout. Add `~/.bun/bin` to your `PATH` if it is not there yet.
- `.worktree-hooks/setup` sets up a task worktree the same way, without linking the CLI.
- `bin/agent-record` runs Bun through mise from `$MISE_DATA_DIR`, or `~/.local/share/mise` when that is unset, never through `XDG_DATA_HOME`, so a test or command that points `XDG_DATA_HOME` at a scratch directory still runs the CLI; `scripts/source-launcher.test.ts`, in the check, holds this. If you set `XDG_DATA_HOME` for your whole shell, set `MISE_DATA_DIR` to where mise keeps its installs.
- `.githooks/` holds the commit-subject, format and no-comments gates.
- [cniska-skills](https://github.com/cniska/agent-skills) is one workflow to contribute with: the skills and hooks this repository is worked with.

## Checks

- `bun run check` runs the lint, the typecheck, knip (an export, file or dependency nothing uses) and the tests.
- `bun run acceptance` proves the criteria in [`SPEC.md`](../SPEC.md) through the CLI alone; each test in `acceptance/` is named for the criteria it proves, and `src/spec.test.ts`, in the check, fails when the tests and the criteria do not cite each other. Each test gets 20 seconds rather than Bun's default 5, since each syncs a fixture home and drives the CLI and git many times, and a loaded machine times that out at 5; the release criteria keep their own 60-second limit.
- `scripts/build-compiled.sh <outfile>` compiles the release: one executable, from `src/cli-release.ts`, that runs with no Bun or checkout and prints its stamped version on `--version`.
- `npm/agent-record` is the npm package's launcher, a POSIX shell script `scripts/build-npm.ts` fills with the release builds; `scripts/launcher.test.ts`, in the check, runs it over the layouts `npm` and `bun` install, with no runtime on `PATH`.
- `scripts/smoke.sh <executable> <version>` is the release's smoke test: the executable prints the version, then, with its home, data, state and mirror folders all in a fresh scratch folder, runs `sync` and passes `doctor` there; the release runs it on each build and on each registry install.
- `scripts/release.sh patch|minor|major` bumps the version and tags it; `.github/workflows/release.yml` builds the tag into a GitHub release, the npm packages and a Homebrew bump, as [Releasing](releasing.md) says.
- `bun run format` formats `src/`, `acceptance/` and `scripts/` with Biome, and the format gate runs it with the linter off before each commit and stages what it changes in the staged files.
- `bun run search-recall` rebuilds the search recall fixture from the live record, as [`src/query-recall.md`](../src/query-recall.md) describes.
- `.github/workflows/check.yml` runs the check and actionlint on each push and pull request; `commits.yml`, `format.yml` and `no-comments.yml` run the gates.
- `.github/workflows/acceptance.yml` runs the acceptance suite on macOS on `workflow_dispatch` and as the first job of `release.yml`, so a release builds only after it passes.

## Layout

- The Claude Code plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
- [`src/README.md`](../src/README.md) maps the modules and the boundaries between them.

## Rules

[`AGENTS.md`](../AGENTS.md) holds the repository's rules, and [`SPEC.md`](../SPEC.md) states what must hold.
