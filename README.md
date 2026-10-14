# agent-record

A local record of what every coding-agent session on this machine did, kept verbatim, for agents to search and the owner to measure from.

- `agent-record sync` reads the session files of Claude Code, Codex, Grok, pi and omp into one SQLite database, with the commits of the repos those sessions worked in and the cniska-skills plugin's hook event log.
- `agent-record query` and `agent-record sql` read it. Search comes first: `query search` finds where earlier work was said, decided or ran into friction, and `query thread` shows what happened around it.
- It needs no network and no credential, and has no per-token cost.

## Install

agent-record runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-record.git
cd agent-record
mise trust && mise install
```

`mise install` installs Bun and the dependencies, and puts `agent-record` in `~/.bun/bin` with `bun link`. Add that directory to your `PATH` if it is not there yet. Then build the record and check it:

```bash
agent-record sync
agent-record doctor
```

Then install the Claude Code plugin, the preferred way to keep the record current and point every session at it:

```bash
claude plugin install cniska-record@cniska
```

## Why

A session's context ends at compaction, at a handoff, or when another agent takes over, and the tool may later delete its transcript. agent-record keeps every session file as the tool wrote it, in an archive that outlasts the tool's own copy and is mirrored off the machine. It reads those files beside the commits of the repos they worked in.

A memory tool decides what an agent should remember: it distills sessions into facts or summaries and puts them into the agent's context. agent-record distills nothing and puts none of it into a context. An agent or the owner asks it, and it answers from what happened:

- What was decided before?
- What happened after a handoff?
- Why did the owner switch agents mid-task?
- How does the owner actually work? The answers are evidence for codifying that workflow.
- Did a workflow change help? `query signal` counts the friction the owner feels per week, and `query before-after` compares it on either side of the commit that made the change.

The [search-sessions](https://github.com/cniska/agent-skills/tree/main/skills/search-sessions) skill in [cniska/agent-skills](https://github.com/cniska/agent-skills) asks it first.

## Commands

Each command prints one JSON line.

| Command | Does |
| --- | --- |
| `agent-record sync` | Copy every new byte of every tool's session files and of the cniska-skills hook event log into the archive and read them from there, then the commits and files of the checkouts they name that changed since the last sync, then mirror the archive |
| `agent-record rebuild` | Drop the record and read it again from the archive |
| `agent-record agent install` | Write a launchd agent that runs `sync` every 15 minutes |
| `agent-record doctor` | Judge whether the record is current and readable, naming the fix for each problem; exits 1 when a check fails |
| `agent-record query list` | Name the queries |
| `agent-record query search "<words>"` | Find messages by keyword |
| `agent-record query thread <id-prefix> [--at <ts>]` | Read the exchange around a hit |
| `agent-record query prior-art "<path fragment>"` | Find where a file shape already exists on disk |
| `agent-record query signal <name> [--by <week\|repo\|route>] [--skill <name>]` | Count one friction signal per week, over every task or the tasks that loaded a skill: `owner-interrupts`, `time-to-land`, `stranded-work`, `review-loops`, `false-stops`, `review-returns`, `blocks` or `skill-usage` |
| `agent-record query signal-events <name>` | List what a signal counted, to check it by hand |
| `agent-record query before-after <sha-prefix> [--days <n>] [--from <ts>] [--skill <name>]` | Compare every signal before and after a commit; with `--skill`, over the tasks that loaded it, naming the versions that ran on each side |
| `agent-record sql "<select>"` | Run one read-only statement |

The record lives at `$XDG_DATA_HOME/agent-record/sessions.db` (`~/.local/share/agent-record/sessions.db` by default); `src/db-schema.ts` holds its tables.

The archive beside it, `$XDG_DATA_HOME/agent-record/archive/<tool>/`, keeps a copy of every session file `sync` has seen, laid out as the tool lays it out, and the record reads only those copies. A tool deleting its old transcripts loses nothing the archive holds: `rebuild` gives back every session whose file `sync` archived, as it last saw it. A file the tool shrank or rewrote is kept as rewritten. The cniska-skills hook event log is archived at `archive/plugin-data/cniska-skills-<marketplace>/events.jsonl`; a log that shrank or was rewritten, as a reinstalled plugin starts it again, keeps its earlier copy beside it as `events-<n>.jsonl`, and the record keeps its events.

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

`bun run check` runs the lint, the typecheck and the tests. `bun run acceptance` proves the criteria in [`SPEC.md`](SPEC.md) through the CLI alone; each test in `acceptance/` is named for the criteria it proves, and a check in `bun run check` fails when a criterion has no test or a test cites none. `src/query-recall.test.ts` measures search: for each case, a `query search` an agent ran and the message it then opened with `query thread`, it checks the message ranks within the first five hits, and fails when that rate drops below its pinned baseline. The cases sit in `src/query-recall.fixture.json` with every word replaced by a code, so the test needs no live record. `bun run search-recall` takes the cases again from the live record, rewrites the fixture, and prints the rate over the live record and over the fixture, with each miss's words; re-pin the baseline from what it prints. [`AGENTS.md`](AGENTS.md) holds the repository's rules. The Claude Code plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the PATH Claude Code gives a plugin.
