# agent-record

Query your past agent work: every coding-agent session on this machine, kept verbatim even after the tools delete theirs and joined to the commits it made, in one SQLite database. It is not memory, since it puts nothing into an agent's context, and it gates nothing; agent-gates does.

- `agent-record sync` reads the session files of Claude Code, Codex, Grok, pi and omp into that database, with the commits of the repos those sessions worked in and the hook event log any Claude Code plugin writes in the format [`SPEC.md`](SPEC.md) §2.13 defines.
- `agent-record query` and `agent-record sql` read it. Search comes first: `query search` finds where earlier work was said, decided or ran into friction, and `query thread` shows what happened around it.
- It needs no credential and has no per-token cost. Its only network use is a release checking GitHub for, and downloading, a newer release of itself, which `AGENT_RECORD_SKIP_UPDATE=1` turns off.

## Install

agent-record runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-record.git
cd agent-record
mise trust && mise install
```

`mise install` installs Bun and the dependencies. In the clone it also links `agent-record` into `~/.bun/bin` with `bun link`; in a worktree it does not, so removing a worktree never leaves the command pointing at a deleted checkout. Add that directory to your `PATH` if it is not there yet. Then build the record and check it:

```bash
agent-record sync
agent-record doctor
```

Then install the Claude Code plugin, the preferred way to keep the record current and point every session at it:

```bash
claude plugin install cniska-record@cniska
```

## Why

Git keeps what landed. Everything else an agent did lives in each tool's own session files, split by tool and by project, and the tools delete them: Claude Code after 30 days by default (`cleanupPeriodDays`). agent-record keeps those files and joins them to the commits they made, so you can ask:

- **Why is this code like this?** Go from a commit to the session that made it and read what you asked for and corrected there. Git has the diff, not the conversation.
- **What did we already try?** A dropped approach never reaches git. Before redoing work, read what was tried and dropped, months back and in another repo.
- **What do I keep correcting?** Your corrections, failed commands retried unchanged, checks an agent skipped: patterns that show only when counted over hundreds of sessions.
- **Which ways of working hold up?** Git has a feature's commit and the fixes that followed it; the record ties them to the sessions that made them, in every repo, so you can see which approaches needed the fewest fixes and read how they were built.
- **Where does work stall?** How long a task takes from your prompt to origin, and which commits sat unpushed; git has no prompt to time from.

`rg` over the transcripts is fine for a phrase from last week. It cannot search what the tools have deleted, and it cannot count or join: grouping corrections, tying a session to its commits, or checking whether the files a session touched have changed since, so you know whether what it decided still holds. The named queries cover the common questions; `agent-record sql` asks any other.

The questions lead to a workflow that improves itself (kaizen). A reviewing agent, such as the [workflow-review](https://github.com/cniska/agent-skills/tree/main/skills/workflow/workflow-review) skill, finds the friction that repeats; a change to a skill, gate or hook removes it; and the record shows whether that friction dropped after the commit and under the new skill version.

The [search-sessions](https://github.com/cniska/agent-skills/tree/main/skills/workflow/search-sessions) skill in [cniska/agent-skills](https://github.com/cniska/agent-skills) asks it first.

## Commands

Each command prints one JSON line.

| Command | Does |
| --- | --- |
| `agent-record sync` | Copy every new byte of every tool's session files and of every plugin's hook event log into the archive and read them from there, then the commits and files of the checkouts they name that changed since the last sync, then mirror the archive; a record of an older schema version is rebuilt first |
| `agent-record rebuild` | Drop the record and read it again from the archive, naming each checkout no longer on disk whose history it lost |
| `agent-record agent install` | Write a launchd agent that runs `sync` every 15 minutes |
| `agent-record doctor` | Judge whether the record is current and readable, naming the fix for each problem; exits 1 when a check fails |
| `agent-record update [--staged \| --rollback]` | In a release, stage the latest release beside the installed build, which then runs it; `--rollback` removes the staged build and rejects its version. Other commands start a check once a day; `AGENT_RECORD_SKIP_UPDATE=1` turns every check off |
| `agent-record query list` | Name the queries |
| `agent-record query search "<words>"` | Find messages by keyword |
| `agent-record query thread <id-prefix> [--at <ts>]` | Read the exchange around a hit |
| `agent-record query trace <id-prefix>` | Trace a session and every subagent under it step by step, one JSON line per row, for a coach to read instead of transcripts |
| `agent-record query prior-art "<path fragment>"` | Find where a file shape already exists on disk |
| `agent-record query signal <name> [--by <week\|repo\|version\|tag key>] [--skill <name>]` | Count one friction signal per week, over every task or the tasks that loaded a skill: `owner-interrupts`, `time-to-land`, `stranded-work`, `review-loops`, `false-stops`, `review-returns`, `blocks`, `skill-usage`, `lost-context`, `escaped-defects`, `step-cost` or `second-read-asks` |
| `agent-record query signal-events <name>` | List what a signal counted, to check it by hand |
| `agent-record query before-after <sha-prefix> [--days <n>] [--from <ts>] [--skill <name>]` | Compare every signal before and after a commit; with `--skill`, over the tasks that loaded it, naming the versions that ran on each side |
| `agent-record sql "<select>"` | Run one read-only statement |

The record lives at `$XDG_DATA_HOME/agent-record/sessions.db` (`~/.local/share/agent-record/sessions.db` by default); `src/db-schema.ts` holds its tables.

The archive beside it, `$XDG_DATA_HOME/agent-record/archive/<tool>/`, keeps a copy of every session file `sync` has seen, laid out as the tool lays it out, and the record reads only those copies. A tool deleting its old transcripts loses nothing the archive holds: `rebuild` gives back every session whose file `sync` archived, as it last saw it. A file the tool shrank or rewrote is kept as rewritten. Each plugin's hook event log is archived at `archive/plugin-data/<plugin>-<marketplace>/events.jsonl`; a log that shrank or was rewritten, as a reinstalled plugin starts it again, keeps its earlier copy beside it as `events-<n>.jsonl`, and the record keeps its events.

On APFS the first copy of a file is a clone and takes no space of its own. Bytes a session gains after that are appended to the copy, so they are stored twice.

## Mirror

Once a tool deletes a transcript, the archive holds its only copy. Every `sync` therefore mirrors the archive into `~/Library/Mobile Documents/com~apple~CloudDocs/agent-record/archive/`, in iCloud Drive, which carries it off the machine. Set `AGENT_RECORD_MIRROR` to an absolute path to mirror into `$AGENT_RECORD_MIRROR/archive/` instead. The launchd agent does not see a variable set in your shell, so it mirrors to the default.

- A sync copies each archive file that is new or changed since the last; it never deletes a mirror copy, so a file the archive moved stays at its old path too. Before a smaller or empty archive file replaces a mirror copy, the old copy is set aside beside it as `<name>.agent-record-backup` (then `-2`, `-3`, ...).
- A sync whose record write fails still mirrors the archive.
- The mirror keeps the archive only. The record is rebuilt from the archive, and no command reads the mirror.
- When the mirror folder's parent is missing, as when iCloud Drive is off, a sync mirrors nothing and says so in its `mirror` result; the sessions are read as usual.
- `agent-record doctor` warns when the mirror is out of reach, has never held the whole archive, or was last brought up to date more than a day ago.

To restore a lost archive, stop anything that syncs (`launchctl bootout gui/$(id -u)/dev.agentrecord.sync` for the launchd agent; Claude Code sessions start a sync too), have iCloud download the folder (in Finder, Download Now on `agent-record` in iCloud Drive), then copy it back and rebuild:

```bash
mkdir -p ~/.local/share/agent-record
ditto ~/Library/Mobile\ Documents/com~apple~CloudDocs/agent-record/archive ~/.local/share/agent-record/archive
agent-record rebuild
```

`ditto` adds to an archive that is still partly there and replaces the files both hold with the mirror's copy, so restore into an empty archive unless you mean that. A Codex rollout the archive moved comes back at both its paths; the record still holds its session once.

## Claude Code plugin

The `cniska-record` plugin, in the `cniska` marketplace, is the preferred install path. Whenever a Claude Code session starts, resumes, clears or compacts, it:

- starts `agent-record sync` in the background, so the record stays current;
- adds a short note to the session, `plugin/hooks/note.md`, telling the agent to search the record before acting on a handoff or plan.

The plugin brings neither Bun nor the CLI, and does nothing when `agent-record` is not on PATH. Install the CLI first, as above. The launchd agent (`agent-record agent install`) is the alternative for keeping the record current while Claude Code is not running.

## Development

### Setup

```bash
mise trust && mise install
agent-worktree create <name>
agent-gates doctor
```

- `mise install` sets up the clone as [Install](#install) says, and the `bun install` its postinstall runs calls the `prepare` script, which points `core.hooksPath` at `.githooks/`.
- `agent-worktree create <name>` makes a task worktree and runs `scripts/worktree-setup.sh` in it, which installs the same way without linking the CLI.
- `.githooks/` holds the commit-subject, format and no-comments gates that [agent-gates](https://github.com/cniska/agent-gates) installs, and `agent-gates doctor` reports their health.

### Checks

- `bun run check` runs the lint, the typecheck, knip (an export, file or dependency nothing uses) and the tests.
- `bun run acceptance` proves the criteria in [`SPEC.md`](SPEC.md) through the CLI alone; each test in `acceptance/` is named for the criteria it proves, and `src/spec.test.ts`, in the check, fails when the tests and the criteria do not cite each other.
- `scripts/build-compiled.sh <outfile> [<version>]` compiles the release: one executable, from `src/cli-release.ts`, that runs with no Bun or checkout and prints its stamped version on `--version`.
- `scripts/release.sh patch|minor|major` bumps the version and tags it; `.github/workflows/release.yml` builds the tag into a GitHub release, the npm packages and a Homebrew bump, as [`docs/releasing.md`](docs/releasing.md) says.
- `bun run format` formats `src/`, `acceptance/`, `scripts/` and `npm/` with Biome, and the format gate runs it with the linter off before each commit and stages what it changes in the staged files.
- `bun run search-recall` rebuilds the search recall fixture from the live record, as [`src/query-recall.md`](src/query-recall.md) describes.
- `.github/workflows/check.yml` runs the check and the acceptance suite on each push and pull request, and `commits.yml`, `format.yml` and `no-comments.yml` run the gates.

### Layout

- The Claude Code plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
- [`src/README.md`](src/README.md) maps the modules and the boundaries between them.

### Rules

[`AGENTS.md`](AGENTS.md) holds the repository's rules, and [`SPEC.md`](SPEC.md) states what must hold.
