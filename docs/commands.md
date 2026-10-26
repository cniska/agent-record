# Commands

The `agent-record` commands, and where the record and its archive live.

Each command prints one [TOON](https://toonformat.dev) document: its result on stdout, or its error on stderr with exit 1. A query or `sql` prints its rows as a table of every column it returns. The named queries cover the common questions; `agent-record sql` asks any other.

| Command | Does |
| --- | --- |
| `agent-record sync` | Copy every new byte of every tool's session files and of every plugin's hook event log into the archive and read them from there, then the commits and files of the checkouts they name that changed since the last sync, then mirror the archive; a record of an older schema version is rebuilt first |
| `agent-record rebuild` | Drop the record and read it again from the archive, naming each checkout no longer on disk whose history it lost, after copying the record to the `backup` it names; once it succeeds, that copy is the only backup of the record kept, and `doctor` names it with its size |
| `agent-record agent install` | Write a launchd agent that runs `sync` every 15 minutes |
| `agent-record doctor` | Judge whether the record is current and readable, naming the fix for each problem; exits 1 when a check fails |
| `agent-record query list` | Name the queries |
| `agent-record query search "<words>"` | Find messages by keyword |
| `agent-record query thread <id-prefix> [--at <ts>]` | Read the exchange around a hit |
| `agent-record query tasks <id-prefix>` | List a session's tasks, from one task prompt to the next, by id, latest last |
| `agent-record query trace <id-prefix> [--task <id-prefix>]` | Trace a session's latest task, or the one named, or a subagent and every subagent under it, step by step, one row per step start or end, for an agent to read instead of transcripts; [Trace](trace.md) says what it shows and cannot |
| `agent-record query prior-art "<path fragment>"` | Find where a file shape already exists on disk |
| `agent-record query signal <name> [--by <week\|repo\|version\|rule\|tag key>] [--skill <name>]` | Count one friction signal per week, over every task or the tasks that loaded a skill: `owner-interrupts`, `time-to-land`, `stranded-work`, `review-findings`, `false-stops`, `review-returns`, `blocks`, `skill-usage`, `lost-context`, `escaped-defects`, `step-cost` or `second-read-asks` |
| `agent-record query signal-events <name>` | List what a signal counted, to check it by hand |
| `agent-record query before-after <sha-prefix> [--days <n>] [--from <ts>] [--skill <name>]` | Compare every signal before and after a commit; with `--skill`, over the tasks that loaded it, naming the versions that ran on each side |
| `agent-record sql "<select>"` | Run one read-only statement |

A workflow that writes `tag` lines to its hook event log groups any signal by them, with `--by <tag key>`.

## Where the record lives

The record lives at `$XDG_DATA_HOME/agent-record/sessions.db` (`~/.local/share/agent-record/sessions.db` by default); `src/db-schema.ts` holds its tables.

The archive beside it, `$XDG_DATA_HOME/agent-record/archive/<tool>/`, keeps a copy of every session file `sync` has seen, laid out as the tool lays it out. The record reads only those copies.

- **A deleted transcript.** A tool deleting its old transcripts loses nothing the archive holds: `rebuild` gives back every session whose file `sync` archived, as it last saw it. A file the tool shrank or rewrote is kept as rewritten.
- **Hook event logs.** Each plugin's hook event log is archived at `archive/plugin-data/<plugin>-<marketplace>/events.jsonl`. A log that shrank or was rewritten, as a reinstalled plugin starts it again, keeps its earlier copy beside it as `events-<n>.jsonl`, and the record keeps its events.
- **Git history.** It is read from the checkouts on disk, not the archive: `sync` keeps the history of a checkout no longer on disk, and `rebuild` loses it, naming the checkout.
- **Disk space.** On APFS the first copy of a file is a clone and takes no space of its own. Bytes a session gains after that are appended to the copy, so they are stored twice.

Every `sync` also copies the archive off the machine, as [Mirror](mirror.md) says.
