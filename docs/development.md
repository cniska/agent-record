# Development

Setup, checks and layout, for working on this repo.

## Setup

```bash
mise trust && mise install
```

- `mise install` sets up the clone as the [README](../README.md#install) says, and the `bun install` its postinstall runs calls the `prepare` script, which points `core.hooksPath` at `.githooks/`. Only in the clone, never in a worktree, does it link `agent-record` into `~/.bun/bin`, so removing a worktree never leaves the command pointing at a deleted checkout.
- `.worktree-hooks/setup` sets up a task worktree the same way, without linking the CLI.
- `.githooks/` holds the commit-subject, format and no-comments gates.
- [cniska-skills](https://github.com/cniska/agent-skills) is one workflow to contribute with: the skills and hooks this repository is worked with.

## Checks

- `bun run check` runs the lint, the typecheck, knip (an export, file or dependency nothing uses) and the tests.
- `bun run acceptance` proves the criteria in [`SPEC.md`](../SPEC.md) through the CLI alone; each test in `acceptance/` is named for the criteria it proves, and `src/spec.test.ts`, in the check, fails when the tests and the criteria do not cite each other.
- `scripts/build-compiled.sh <outfile>` compiles the release: one executable, from `src/cli-release.ts`, that runs with no Bun or checkout and prints its stamped version on `--version`.
- `npm/agent-record` is the npm package's launcher, a POSIX shell script `scripts/build-npm.ts` fills with the release builds; `scripts/launcher.test.ts`, in the check, runs it over the layouts `npm` and `bun` install, with no runtime on `PATH`.
- `scripts/release.sh patch|minor|major` bumps the version and tags it; `.github/workflows/release.yml` builds the tag into a GitHub release, the npm packages and a Homebrew bump, as [Releasing](releasing.md) says.
- `bun run format` formats `src/`, `acceptance/` and `scripts/` with Biome, and the format gate runs it with the linter off before each commit and stages what it changes in the staged files.
- `bun run search-recall` rebuilds the search recall fixture from the live record, as [`src/query-recall.md`](../src/query-recall.md) describes.
- `.github/workflows/check.yml` runs the check and the acceptance suite on each push and pull request, and `commits.yml`, `format.yml` and `no-comments.yml` run the gates.

## Layout

- The Claude Code plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
- [`src/README.md`](../src/README.md) maps the modules and the boundaries between them.

## Rules

[`AGENTS.md`](../AGENTS.md) holds the repository's rules, and [`SPEC.md`](../SPEC.md) states what must hold.
