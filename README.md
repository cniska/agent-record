# agent-record

A local record of every coding-agent session on this machine, and the queries that bring earlier work back to an agent.

- `agent-record sync` reads the session files of Claude Code, Codex, Grok, pi and omp into one SQLite database, with the commits of the repos those sessions worked in.
- `agent-record query` and `agent-record sql` read it.
- It needs no network and no credential, and has no per-token cost.

## Why

An experiment in giving coding agents a memory of their own work.

A session's context ends at compaction, at a handoff, or when another agent takes over. The transcripts on disk keep everything that was said and decided. agent-record makes those transcripts something an agent can ask:

- What was decided before?
- What happened after a handoff?
- Why did the owner switch agents mid-task?
- How does the owner actually work? The answers are evidence for codifying that workflow.

The [search-sessions](https://github.com/cniska/agent-skills/tree/main/skills/search-sessions) skill in [cniska/agent-skills](https://github.com/cniska/agent-skills) asks it first.

## Commands

Each command prints one JSON line.

| Command | Does |
| --- | --- |
| `agent-record sync` | Read every new byte of every tool's session files, then the commits and files of the repos they name |
| `agent-record rebuild` | Drop the record and read it again from the session files |
| `agent-record agent install` | Write a launchd agent that runs `sync` every 15 minutes |
| `agent-record doctor` | Judge whether the record is current and readable, naming the fix for each problem; exits 1 when a check fails |
| `agent-record query list` | Name the queries |
| `agent-record query search "<words>"` | Find messages by keyword |
| `agent-record query thread <id-prefix>[@<ts>]` | Read the exchange around a hit |
| `agent-record query prior-art "<path fragment>"` | Find where a file shape already exists on disk |
| `agent-record sql "<select>"` | Run one read-only statement |

The record lives at `$XDG_DATA_HOME/agent-record/sessions.db` (`~/.local/share/agent-record/sessions.db` by default); `src/db-schema.ts` holds its tables.

## Setup

Install [mise](https://mise.jdx.dev), then:

```bash
mise install && bun install
ln -s "$PWD/bin/agent-record" ~/.local/bin/agent-record
agent-record sync
```

## Claude Code plugin

The `cniska-record` plugin, in the `cniska` marketplace, keeps the record current without the launchd agent. It starts `agent-record sync` in the background at the start of every Claude Code session.

The plugin brings neither Bun nor the CLI, and runs only when `agent-record` is on PATH. Install the CLI first, as above.

```bash
claude plugin install cniska-record@cniska
```

`bun run check` is the repository check.
