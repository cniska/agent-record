# agent-record Specification

> A local record of every coding-agent session on this machine, and the queries that bring earlier work back to an agent.

This document states what must hold, not how. [`README.md`](README.md) lists the commands and [`src/README.md`](src/README.md) maps the modules that meet these requirements.

**Status: reverse-engineered from the code at `c0ea408`, unverified.** Each requirement states behavior the code shows today, or, where §9 says so, behavior it must reach. None is contract until the owner confirms it. §9 lists the open questions and the known gaps.

## 1. Purpose & context

A coding agent's context ends at compaction, at a handoff, or when another agent takes over. The tools' transcripts on disk keep what was said, decided and done, but each tool keeps them in its own format and place, and may delete them. agent-record copies them into one archive, reads that archive into one SQLite record, and answers questions over it.

**Primary user:** the owner's coding agents on the owner's own machine, through the CLI and the Claude Code plugin; the owner when diagnosing the record. Not the audience: other users of the machine, remote services, teams sharing a record.

## 2. Functional requirements

### 2.1 Archive

- **FR-1** — `sync` copies every session file of Claude Code, Codex, Grok, pi and omp it finds under each tool's home into the archive, at the same path relative to the tool's root.
- **FR-2** — A session file that grew since the last sync has its new bytes added to its archive copy.
- **FR-3** — A session file that a tool deleted keeps its archive copy, and the record keeps the sessions read from it.
- **FR-4** — A session file that a tool shrank or rewrote, in a way the archive detects, replaces its archive copy, and the record's rows for that session are replaced by what the new copy holds.
- **FR-5** — A Codex rollout that Codex moved, such as into `archived_sessions`, is moved in the archive too, and is recorded once, not twice.
- **FR-6** — The files a tool keeps beside its transcripts that the record reads (Claude subagent metadata, Grok session summaries, Codex thread titles) are archived with them.

### 2.2 Ingest

- **FR-7** — The record is read from the archive only, never from a tool's own files.
- **FR-8** — Each sync reads only the bytes an archive copy gained since the last sync.
- **FR-9** — A line still being written, with no newline yet, is not read until it is complete.
- **FR-10** — A line that cannot be parsed is skipped, the rest of its file is read, and the sync reports the file and line number.
- **FR-11** — A file that cannot be read or archived does not stop the sync: the other files are read, and the sync's result lists each failure as a refusal naming its fix.
- **FR-12** — A subagent session is recorded with its parent session. A subagent whose parent is not in the record is recorded without one, and the sync reports it.
- **FR-13** — The record holds, per session: its tool, parent, agent type, working directory, project, branch, tool version, entry point, first and last time, and title; per message: its role, time, model, text and source line; per turn: its start, end, duration, status and model; per model response: its token counts; per tool call: its tool, command or file, the git subcommands its command ran, its outcome and its times.
- **FR-14** — A message's text that a tool wrote across several lines under one id is recorded as one message.
- **FR-15** — A model response recorded several times while it streamed is counted once, with its final token counts.
- **FR-16** — For every tool, `input_tokens` counts input tokens excluding cache reads; cache reads and cache writes have their own counts.
- **FR-17** — Each skill load is recorded once, tied to what caused it: the tool call, for a load a tool caused (the Skill tool, or reading a `SKILL.md`); the user's message, for a skill the user typed as a slash command.
- **FR-18** — A session that ran in a Claude worktree records the checkout it belongs to as its project, and the worktree's name apart.

### 2.3 Git history

- **FR-19** — `sync` records the non-merge commits, with their author, time, subject, Conventional Commit type and changed files, of every git checkout a recorded session's working directory lies in, and labels each repo by its origin remote.
- **FR-20** — `sync` records the tracked files of each of those checkouts.
- **FR-21** — A checkout in a scratch location, such as a temporary directory, is not the owner's work and is not read.
- **FR-22** — A checkout unchanged since the last sync is not read again.
- **FR-60** — Git history is read from the checkouts on disk when `sync` runs, not from the archive. A checkout no longer on disk is not read: `sync` keeps the history it recorded before, and `rebuild` does not.

### 2.4 Rebuild

- **FR-23** — `rebuild` drops the record and reads it again from the archive, whatever schema version the record had.
- **FR-24** — After `rebuild`, every session `sync` archived is in the record as the archive last held it, including sessions whose tool files are gone. Git history is not covered (FR-60).
- **FR-25** — Given the same archive, `rebuild` writes the same session, message, turn, usage, tool-call and skill-load rows that the syncs that built the archive wrote.

### 2.5 Schema version

- **FR-26** — The record carries one schema version.
- **FR-27** — Every command that reads or writes the record, except `rebuild`, refuses a record of another schema version.
- **FR-28** — A refusal of an older record names `agent-record rebuild` as its fix; a refusal of a newer record names running an agent-record that reads that version.

### 2.6 Commands and output

- **FR-29** — Every command prints exactly one JSON line. A command that ran prints `{command, ok: true, result}` to stdout; a command refused or faulted prints `{command, ok: false, error}` to stderr and exits 1. `ok` says the command ran, not that what it judged is healthy.
- **FR-30** — Every error is either a refusal (the caller can fix it) or a fault (a bug in agent-record), and carries a code, a message, its facts, and a `resolve` naming the fix. A fault's `resolve` says to hand it to the owner.
- **FR-31** — `agent-record` with no command lists every command with its usage and summary.
- **FR-32** — An unknown command, an unknown flag, a flag without a value, a flag given twice, a wrong argument count, a blank argument and an unknown verb are each refused with the command's usage as the fix.

### 2.7 Queries

- **FR-33** — `query list` names every query with its usage and summary; an unknown query is refused, naming `query list`.
- **FR-34** — A query result carries its columns, its rows, a `denominator` sentence saying what the rows were drawn from, a `more` note when rows were cut, and a `note` saying what the rows cannot show or why the result is empty.
- **FR-35** — A query or `sql` prints a default number of rows, says when it cut rows, and prints another count when `--rows <n>` asks; a `--rows` that is not a whole number of at least 1 is refused.
- **FR-36** — `query search "<words>"` finds messages containing any of the words, ranks them by how many words matched, then relevance, then recency, and gives each hit a reference `thread` accepts.
- **FR-37** — `search` and `thread` cover only text someone said: skill bodies and text the harness injected are left out, except messages another agent or a coordinator sent.
- **FR-38** — `search` names the words that matched nothing anyone said, and, when it searches only some of the distinct words given, says how many it dropped.
- **FR-39** — `query thread` prints a session's messages, denials and tool calls in time order, given a prefix of the session's id; given a time as well, it prints the stretch around that time and says how many rows lie outside it.
- **FR-40** — A session prefix that matches more than one session is refused, naming matches to choose between.
- **FR-41** — `query prior-art "<path fragment>"` lists the tracked files whose path contains the fragment, across the indexed checkouts, worktrees folded onto their checkout, the most recently committed first and a few per repo, and says when it ranked only some.
- **FR-42** — `sql "<statement>"` runs one statement against the record and returns its rows; a statement that would write is refused, and a statement SQLite cannot run is refused with SQLite's reason.
- **FR-59** — `query thread` with a prefix that matches no session answers with no rows and a note saying so, not a refusal.

### 2.8 Health

- **FR-43** — `doctor` reports three checks, each `ok`, `warn` or `fail` with a detail and a fix: the record, the last sync, and the launchd agent.
- **FR-44** — The record check fails when the record is missing, of another schema version, or busy, with the refusal's fix.
- **FR-45** — The sync check fails when no sync has finished, when the last sync failed, or when its outcome cannot be read; it warns when the last sync reported failed files, or finished longer ago than a threshold well past the agent's interval, which the detail states.
- **FR-46** — The agent check warns when the launchd agent is missing, runs another checkout or Bun than this agent-record, or is written but not loaded.
- **FR-47** — `doctor` exits 1 when any check fails, and 0 otherwise.
- **FR-48** — Every `sync` and `rebuild` records its outcome, finished or failed, where `doctor` reads it.

### 2.9 Scheduling and plugin

- **FR-49** — `agent install` writes a launchd agent that runs `sync` every 15 minutes and at login, logging to the state directory, and prints the command that loads it. A run with nothing to change says so.
- **FR-50** — Replacing an existing, different launchd agent first keeps a backup copy of it.
- **FR-51** — The Claude Code plugin starts `sync` in the background whenever a session starts, resumes, clears or compacts, and adds a note telling the agent to search the record before acting on a handoff or plan.
- **FR-52** — The plugin does nothing when `agent-record` is not on PATH.

### 2.10 Edge cases

- **FR-53** — Only one `sync` or `rebuild` runs at a time. A second is refused, naming the process that holds the record.
- **FR-54** — A lock left by a process that has ended is taken over, not refused.
- **FR-55** — Queries and `sql` read while a `sync` writes, without waiting for it to finish.
- **FR-56** — A read that cannot start because another process holds the record is refused, naming that cause, not reported as a fault.
- **FR-57** — A query or `sql` against a record that does not exist is refused, naming `agent-record sync`, and creates nothing.
- **FR-58** — A Codex token record that claims more cached input than input is skipped as malformed.

## 3. Non-functional requirements

- **NF-1** — agent-record needs no network and no credential, and sends nothing off the machine.
- **NF-2** — A sync that finds nothing new reads no session file, copies no bytes into the archive, and reads no checkout again.
- **NF-3** — On APFS, the first archive copy of a file takes no space of its own.
- **NF-4** — No command leaves the record half-written: a file's rows and its cursor are written together or not at all.
- **NF-5** — No command crashes with an uncoded error on a common failure: a missing record, a busy record, a held lock, an unreadable or unwritable file, a missing git, a malformed tool file.

### 3.1 Testing

- **NF-6** — `bun run check` runs the lint, the typecheck and the tests, and passes before every commit.
- **NF-7** — No test waits real time.
- **NF-8** — Each tool's parser has tests over sample lines of that tool's format, including a malformed line.

## 4. Out of scope

- Reading sessions from another machine, or sharing a record.
- Writing to a tool's files, or to the record through `sql`.
- Semantic or embedding search; `search` matches words.
- Judging quality: `prior-art` ranks by recency and commit count only.
- Restoring the git history of a checkout no longer on disk (FR-60).
- Any platform but macOS.

## 5. Acceptance criteria

- **AC-1** — Run `sync` over fixture homes for all five tools: each session is in the archive and the record, with its facts, messages, turns, token counts, tool calls with their git subcommands, and skill loads. (FR-1, FR-6, FR-7, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18)
- **AC-2** — Append lines to a fixture transcript, one without a trailing newline, and sync again: only the complete new lines are added. (FR-2, FR-8, FR-9)
- **AC-3** — Delete a tool's fixture file and sync: the session stays in the record. Then `rebuild`: it is still there. (FR-3, FR-23, FR-24)
- **AC-4** — Rewrite a fixture transcript shorter and sync: the session holds only the new content. (FR-4)
- **AC-5** — Move a Codex rollout into `archived_sessions` and sync: one copy in the archive, one session in the record. (FR-5)
- **AC-6** — Change a tool's fixture file after archiving it, then `rebuild` from the archive alone: the record matches the archive, not the tool's file. (FR-7)
- **AC-7** — Sync a fixture with a malformed line, an unreadable file and an orphan subagent: the sync finishes, and its report names the line, the failure with its fix, and the orphan. (FR-10, FR-11, FR-12)
- **AC-8** — Sync with a fixture session in a fixture git repo with an origin remote, and in a repo under a temp directory: the first repo's commits with their types, its label and its files are recorded, the temp repo's are not; a second sync with no change reads neither. (FR-19, FR-20, FR-21, FR-22)
- **AC-9** — Sync fixtures, then `rebuild`: the session, message, turn, usage, tool-call and skill-load rows are identical. (FR-25)
- **AC-10** — Set the record's schema version lower, then higher: `sync`, `query` and `sql` each refuse, naming `agent-record rebuild` and a newer agent-record respectively; `rebuild` succeeds on the lower one. (FR-23, FR-26, FR-27, FR-28)
- **AC-11** — Run each command once successfully and once with bad input, and `doctor` with a failing check: the successful runs and `doctor` print `ok: true` on stdout, `doctor` exiting 1; the bad input prints `ok: false` on stderr with exit 1, and the error carries kind, code, message, meta and resolve. (FR-29, FR-30)
- **AC-12** — Run `agent-record` alone, an unknown command, and each malformed argument form: the listing and each refusal with its usage. (FR-31, FR-32)
- **AC-13** — `query list`, an unknown query, `--rows 0`, and a query with more rows than the default: listing, refusals, and the `more` note. (FR-33, FR-34, FR-35)
- **AC-14** — `search` for words in a said message, in a skill body, and in no message, with more distinct words than it searches: the said message ranks by matched words, the skill body is absent, the unmatched and dropped words are named, and a hit's reference opens in `thread`. (FR-34, FR-36, FR-37, FR-38)
- **AC-15** — `thread` on a whole session, around a time, with an ambiguous prefix, and with an unknown prefix: rows in order, the counts outside the stretch, the refusal naming matches, and an empty result with its note. (FR-39, FR-40, FR-59)
- **AC-16** — `prior-art` over fixture repos with a worktree and more matching files per repo than it ranks: matches folded onto the checkout, newest first, and the denominator saying only some were ranked. (FR-41)
- **AC-17** — `sql` with a SELECT, an INSERT and a syntax error: rows, a `sql_writes` refusal, and a `sql_invalid` refusal with SQLite's reason. (FR-42)
- **AC-18** — `doctor` with no record, a busy record, a stale sync stamp, a failed sync, a sync with failed files, and each launchd agent state: each check's state and fix, and exit 1 exactly when one fails. (FR-43, FR-44, FR-45, FR-46, FR-47)
- **AC-19** — A `sync` that succeeds, one with failed files and one that faults: each leaves an outcome `doctor` reads. (FR-48)
- **AC-20** — `agent install` with no agent, the same agent, and a different one: written with the loading command, unchanged, and replaced with a backup. (FR-49, FR-50)
- **AC-21** — Run the plugin hook with and without `agent-record` on PATH: it starts `sync` and prints the note, or does nothing. (FR-51, FR-52)
- **AC-22** — Start a second `sync` while one holds the lock: it is refused naming the holder. Leave a lock from an ended process: the next `sync` takes it. (FR-53, FR-54)
- **AC-23** — Query while a writer holds a write transaction: the query answers. Hold the record exclusively: the query is refused as busy. (FR-55, FR-56)
- **AC-24** — `query` and `sql` with no record: refused naming `agent-record sync`, and no file is created. (FR-57)
- **AC-25** — A Codex token record with more cached input than input: skipped and reported as a dropped line. (FR-58)
- **AC-26** — Sync with the network unavailable: it succeeds. (NF-1)
- **AC-27** — Sync fixtures, then sync again with nothing changed: the second report reads no file, archives no bytes, and counts every checkout unchanged. (NF-2)
- **AC-28** — Interrupt a sync mid-file: the next sync reads that file from where the last whole write left it, with no duplicate rows. (NF-4)
- **AC-29** — Each failure in NF-5 produces a refusal with a code and fix, never `command_failed`. (NF-5)
- **AC-30** — `bun run check` passes, the suite has no real-time waits, and each parser has a malformed-line test. (NF-6, NF-7, NF-8)
- **AC-31** — On APFS, a fresh archive copy adds no allocated blocks. (NF-3)
- **AC-32** — Sync with a fixture repo, delete the repo, sync, then `rebuild`: the sync keeps its commits, the rebuild has none. (FR-60)

## 6. Deliverables

- **D-1** — The `agent-record` CLI, run by Bun from a checkout and linked onto PATH by `mise install`.
- **D-2** — The `cniska-record` Claude Code plugin in `plugin/`.
- **D-3** — `README.md` (install, commands, where the record lives), `AGENTS.md` (repository rules), `src/README.md` (module map), and this spec.
- **D-4** — The test suite, run by `bun run check`.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun.
- **C-2** — The record is one SQLite database under `$XDG_DATA_HOME/agent-record/`, beside the archive.
- **C-3** — Local only: no server, no network, no account.
- **C-4** — The archive is the source of truth for sessions; the session record is derived from it and can always be rebuilt.
- **C-5** — Every command's output is one JSON line, for agents to read.

## 8. Open decisions (left to the builder)

- The record's tables and columns, provided FR-13 holds and a table change bumps the schema version (FR-26).
- How the archive detects that a file grew, shrank, was rewritten or moved (bounded by FR-2, FR-4, FR-5).
- How sync tells a checkout is unchanged (bounded by FR-22), and how far back a changed checkout's commits are re-read (bounded by FR-19).
- Which locations count as scratch (bounded by FR-21).
- The default row count, the number of words `search` takes, the files per repo `prior-art` ranks, and the stale-sync threshold, provided each result says what it cut (FR-35, FR-38, FR-41, FR-45).
- How search ranks within equal matched-word counts (bounded by FR-36).
- How long a writer waits for another writer before it is refused (bounded by FR-53 and NF-7).
- The shape of the reference `search` gives and `thread` takes (bounded by FR-36, FR-39).

### Policies chosen (not open)

- `ok` in a command's output means the command ran; a judgement it makes, such as `doctor`'s, is in its result and its exit code (FR-29, FR-47).
- A busy record is a `fail` in `doctor`, not a `warn` (FR-44).
- A busy record is SQLite reporting the database held; a race for agent-record's own lock is a separate refusal (FR-53, FR-56).
- The launchd agent's 15-minute interval is promised to the user (FR-49).

## 9. Open questions and known gaps

Each requirement still needs the owner's confirmation before it is contract.

Known gaps, where the code does not yet meet a requirement:

- **The criteria have no tests by ID.** They are to be proven by an acceptance suite that drives only the CLI, with a check tying the suite to this spec; the existing unit tests stay unit tests and cite no ID.
- **NF-7.** Eight tests wait real time: in `src/db.test.ts`, `src/db-lock.test.ts` and `src/plugin-hook.test.ts`.
- **FR-4.** A rewrite that keeps a file's size and modification time is not detected.
