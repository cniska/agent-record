# agent-record

> Session record for coding agents: every past session on this machine, queryable and joined to its commits

[![CI](https://img.shields.io/github/actions/workflow/status/cniska/agent-record/check.yml?branch=main&style=flat&label=ci)](https://github.com/cniska/agent-record/actions/workflows/check.yml) [![npm](https://img.shields.io/npm/v/@cniska/agent-record?style=flat&label=npm)](https://www.npmjs.com/package/@cniska/agent-record) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

It keeps each session verbatim in one SQLite database, even after the tool that wrote it deletes its own copy. It is not memory, since it puts nothing into an agent's context, and it gates nothing.

- `agent-record sync` reads the session files of Claude Code, Codex, Grok, pi and omp into that database, with the commits of the repos those sessions worked in and the hook event log any Claude Code plugin writes in the format [`SPEC.md`](SPEC.md) §2.13 defines.
- `agent-record query` and `agent-record sql` read it. Search comes first: `query search` finds where earlier work was said, decided or ran into friction, and `query thread` shows what happened around it.
- It needs no credential, has no per-token cost and never reaches the network.

## Install

Each channel installs the latest release, built for macOS on Apple silicon and for Linux on x64. Install it one way.

With curl:

```bash
curl -fsSL https://github.com/cniska/agent-record/releases/latest/download/install.sh | sh
```

With Homebrew:

```bash
brew install cniska/tap/agent-record
```

With npm:

```bash
npm install -g @cniska/agent-record
```

With bun:

```bash
bun add -g @cniska/agent-record
```

Each channel updates the way it installed: `brew upgrade agent-record`, `npm update -g @cniska/agent-record`, `bun update -g @cniska/agent-record`, or the curl line run again.

From source, with [mise](https://mise.jdx.dev) installed:

```bash
git clone https://github.com/cniska/agent-record.git
cd agent-record
mise trust && mise install
```

`mise install` installs actionlint, the dependencies and [Bun](https://bun.sh), which the source runs on, and in the clone links `agent-record` into `~/.bun/bin`. Add that directory to your `PATH` if it is not there yet.

However you installed it, build the record and check it:

```bash
agent-record sync
agent-record doctor
```

Then install the Claude Code plugin, the preferred way to keep the record current and point every session at it:

```bash
claude plugin install cniska-record@cniska
```

## Uninstall

1. If you ran `agent-record agent install`, unload the launchd agent, then remove its plist and the backup copies of it beside it:

   ```bash
   launchctl bootout gui/$(id -u)/dev.agentrecord.sync
   rm -f ~/Library/LaunchAgents/dev.agentrecord.sync.plist*
   ```

2. Remove the plugin: `claude plugin uninstall cniska-record@cniska`.
3. Remove the CLI the way it was installed:
   - **curl:** `rm ~/.local/bin/agent-record`, and the `export PATH` line the installer added to your `~/.zshrc`, `~/.bashrc` or `~/.bash_profile`, if it added one.
   - **Homebrew:** `brew uninstall agent-record`.
   - **npm:** `npm uninstall -g @cniska/agent-record`.
   - **bun:** `bun remove -g @cniska/agent-record`.
   - **From source:** `bun unlink` in the clone, then delete the clone.
4. Remove `~/.local/state/agent-record/` (`$XDG_STATE_HOME/agent-record/` when that is set), which holds the sync log, the last-sync stamp and the locks.
5. The data folder and the mirror hold the archive, which may be the only copy left of transcripts the tools have deleted: copy them elsewhere first if you may want those sessions. Then remove the data folder, `~/.local/share/agent-record/` (`$XDG_DATA_HOME/agent-record/` when that is set), and the [mirror](docs/mirror.md), `agent-record/` in iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/agent-record/`, or the folder `$AGENT_RECORD_MIRROR` names when that is set).

## Why

Git keeps what landed. Everything else an agent did lives in each tool's own session files, split by tool and by project, and the tools delete them: Claude Code after 30 days by default (`cleanupPeriodDays`). agent-record keeps those files and joins them to the commits they made, so you can ask:

- **Why is this code like this?** Go from a commit to the session that made it and read what you asked for and corrected there.
- **What did we already try?** A dropped approach never reaches git. Read what was tried and dropped, months back and in another repo.
- **What do I keep correcting?** Corrections, failed commands retried unchanged, checks an agent skipped: patterns that show only when counted over hundreds of sessions.
- **Which ways of working hold up?** The record ties a feature's commit and the fixes that followed it to the sessions that made them, in every repo.
- **Where does work stall?** How long a task takes from your prompt to origin, and which commits sat unpushed.

`rg` over the transcripts finds a phrase from last week. It cannot search what the tools have deleted, and it cannot count or join: group corrections, tie a session to its commits, or check whether the files a session touched have changed since.

An agent reading the record finds the friction that repeats; a change to a skill, gate or hook removes it; and the record shows whether that friction dropped after the change.

## Commands

Each command prints one JSON line. The essentials:

| Command | Does |
| --- | --- |
| `agent-record sync` | Read every tool's new session bytes and the commits of the checkouts they name into the record |
| `agent-record doctor` | Judge whether the record is current and readable, naming the fix for each problem |
| `agent-record query search "<words>"` | Find messages by keyword |
| `agent-record query thread <id-prefix> [--at <ts>]` | Read the exchange around a hit |
| `agent-record query list` | Name the queries |
| `agent-record sql "<select>"` | Run one read-only statement |

[Commands](docs/commands.md) lists every command and where the record lives.

Where the data flows, with tool files standing for the session files and the hook event logs:

```mermaid
flowchart LR
  files[("Tool files")] -- "new bytes" --> archive[("Archive")]
  archive -- "sessions and events" --> record[("Record")]
  git[("Checkouts")] -- "commits, files" --> record
  record -- "rows" --> queries(["Queries"])
  archive -- "copies" --> mirror[("Mirror")]
```

## Docs

- [Commands](docs/commands.md): every command, and where the record and its archive live.
- [Trace](docs/trace.md): what `query tasks` and `query trace` show, and where the transcripts leave gaps.
- [Mirror](docs/mirror.md): the copy of the archive each `sync` keeps in iCloud Drive, and how to restore the archive from it.
- [Claude Code plugin](docs/plugin.md): what the plugin does at session start.
- [Development](docs/development.md): setup, checks and layout, for working on this repo.
- [Releasing](docs/releasing.md): the release workflow, the owner's one-time setup and each release's steps.
