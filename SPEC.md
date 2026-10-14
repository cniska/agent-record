# agent-record Specification

> A local record of every coding-agent session on this machine: the record agent workflows improve from.

This document states what must hold, not how. [`README.md`](README.md) lists the commands and [`src/README.md`](src/README.md) maps the modules that meet these requirements.

**Status: reverse-engineered from the code at `c0ea408`, unverified.** Each requirement states behavior the code shows today, or, where §9 says so, behavior it must reach. None is contract until the owner confirms it. §9 lists the open questions and the known gaps.

## 1. Purpose & context

A coding agent's context ends at compaction, at a handoff, or when another agent takes over. The tools' transcripts on disk keep what was said, decided and done, but each tool keeps them in its own format and place, and may delete them. agent-record copies them into one archive, reads that archive into one SQLite record, and answers questions over it.

The record is what agent workflows improve from. Its first use is search: an agent finds where earlier work was said, decided or ran into friction, and reads the thread around it. Its second is the check: the signals count the friction the owner feels, week by week, and `before-after` compares them on either side of a workflow change, so the change is kept or reverted on evidence.

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
- **FR-10** — A line of a kind the record keeps that cannot be parsed, or that lacks a field its rows need (an id or a time the line records), is skipped, the rest of its file is read, and the sync reports the file and line number. A line of a kind the record does not keep is skipped without a report.
- **FR-11** — A file that cannot be read or archived does not stop the sync: the other files are read, and the sync's result lists each failure as a refusal naming its fix.
- **FR-12** — A subagent session is recorded with its parent session. A subagent whose parent is not in the record is recorded without one, and the sync reports it.
- **FR-13** — The record holds, per session: its tool, parent, agent type, working directory, project, branch, tool version, entry point, first and last time (the earliest and latest timestamp on any line read from its files), and title; per message: its role, time, model, text and source line; per turn: its start, end, duration, status and model; per model response: its token counts; per tool call: its tool, command or file, its git runs (each git subcommand its command ran, and the directory it ran in: the session's working directory, as a `cd` or `git -C` in the command changes it), its outcome and its times.
- **FR-14** — A message's text that a tool wrote across several lines under one id is recorded as one message.
- **FR-15** — A model response recorded several times while it streamed is counted once, with its final token counts.
- **FR-16** — For every tool, `input_tokens` counts input tokens excluding cache reads; cache reads and cache writes have their own counts.
- **FR-17** — Each skill load is recorded once, tied to what caused it: the tool call, for a load a tool caused (the Skill tool, or reading a `SKILL.md`); the user's message, for a skill the user typed as a slash command; the message holding the body, for a skill an agent's definition preloads into its session. A skill is named without the plugin that qualifies it, so `acme:plan` and `plan` are one skill. A load whose skill body the transcript holds records where the skill was loaded from, and the body's length and SHA-256 as the skill's file holds it below its frontmatter: without the line naming the skill's directory, the `ARGUMENTS:` block the harness appends with what the caller passed, and the line breaks at either end. So every load of one version of a skill carries one hash, whatever it was asked. A load from a plugin's install also records that install, the directory the plugin cache names it by.
- **FR-18** — A session that ran in a Claude worktree records the checkout it belongs to as its project, and the worktree's name apart.

### 2.3 Git history

- **FR-19** — `sync` records the non-merge commits, with their author, time, subject, Conventional Commit type and changed files, of every git checkout a recorded session's working directory lies in, and labels each repo by its origin remote.
- **FR-20** — `sync` records the tracked files of each of those checkouts.
- **FR-21** — A checkout in a scratch location, such as a temporary directory, is not the owner's work and is not read.
- **FR-22** — A checkout unchanged since the last sync is not read again.
- **FR-23** — Git history is read from the checkouts on disk when `sync` runs, not from the archive. A checkout no longer on disk, including one removed while `sync` runs, is not read and is not a failure: `sync` keeps the history and tracked files it recorded before, and `rebuild` does not.

### 2.4 Rebuild

- **FR-24** — `rebuild` drops the record and reads it again from the archive, whatever schema version the record had.
- **FR-25** — After `rebuild`, every session `sync` archived is in the record as the archive last held it, including sessions whose tool files are gone. Git history is not covered (FR-23).
- **FR-26** — Given the same archive, `rebuild` writes the same session, message, turn, usage, tool-call, git-run, skill-load and hook-event rows that the syncs that built the archive wrote.

### 2.5 Schema version

- **FR-27** — The record carries one schema version.
- **FR-28** — Every command that reads or writes the record, except `rebuild`, refuses a record of another schema version.
- **FR-29** — A refusal of an older record names `agent-record rebuild` as its fix; a refusal of a newer record names running an agent-record that reads that version.

### 2.6 Commands and output

- **FR-30** — Every command prints exactly one JSON line. A command that ran prints `{command, ok: true, result}` to stdout; a command refused or faulted prints `{command, ok: false, error}` to stderr and exits 1. `ok` says the command ran, not that what it judged is healthy.
- **FR-31** — Every error is either a refusal (the caller can fix it) or a fault (a bug in agent-record), and carries a code, a message, its facts, and a `resolve` naming the fix. A fault's `resolve` says to hand it to the owner.
- **FR-32** — `agent-record` with no command lists every command with its usage and summary.
- **FR-33** — An unknown command, an unknown flag, a flag without a value, a flag given twice, a wrong argument count, a blank argument and an unknown verb are each refused with the command's usage as the fix.

### 2.7 Queries

- **FR-34** — `query list` names every query with its usage and summary; an unknown query is refused, naming `query list`.
- **FR-35** — A query result carries its columns, its rows, a `denominator` sentence saying what the rows were drawn from, a `more` note when rows were cut, and a `note` saying what the rows cannot show or why the result is empty.
- **FR-36** — A query or `sql` prints a default number of rows, says when it cut rows, and prints another count when `--rows <n>` asks; a `--rows` that is not a whole number of at least 1 is refused.
- **FR-37** — `query search "<words>"` finds messages containing any of the words, ranks them by how many words matched, then relevance, then recency, and gives each hit a reference `thread` accepts.
- **FR-38** — `search` and `thread` cover only text someone said: skill bodies and text the harness injected are left out, except messages another agent or a coordinator sent.
- **FR-39** — `search` names the words that matched nothing anyone said, and, when it searches only some of the distinct words given, says how many it dropped.
- **FR-40** — `query thread` prints a session's messages, denials and tool calls in time order, given a prefix of the session's id; given a time as well, it prints the stretch around that time and says how many rows lie outside it. A time a query takes is an ISO time with a `Z` or an offset, to the minute or finer, such as `2026-10-14T09:00Z`, read as that instant in UTC; one without a `Z` or an offset, a date alone, or anything else is refused, naming the shape it takes.
- **FR-41** — A session prefix that matches more than one session is refused, naming matches to choose between.
- **FR-42** — `query prior-art "<path fragment>"` lists the tracked files whose path contains the fragment, across the indexed checkouts, worktrees folded onto their checkout, the most recently committed first and a few per repo, and says when it ranked only some.
- **FR-43** — `sql "<statement>"` runs one statement against the record and returns its result in a query's shape (FR-35); a statement that would write is refused, a statement SQLite cannot run is refused with SQLite's reason, a result that names a column twice is refused naming the column, and a blob is refused naming `hex()`.
- **FR-44** — `query thread` with a prefix that matches no session answers with no rows and a note saying so, not a refusal.

### 2.8 Health

- **FR-45** — `doctor` reports four checks, each `ok`, `warn` or `fail` with a detail and a fix: the record, the last sync, the launchd agent, and the archive's mirror.
- **FR-46** — The record check fails when the record is missing, of another schema version, or busy, with the refusal's fix.
- **FR-47** — The sync check fails when no sync has finished, when the last sync failed, or when its outcome cannot be read; it warns when the last sync reported failed files, or finished longer ago than a threshold well past the agent's interval, which the detail states.
- **FR-48** — The agent check warns when the launchd agent is missing, runs another checkout or Bun than this agent-record, or is written but not loaded.
- **FR-49** — `doctor` exits 1 when any check fails, and 0 otherwise.
- **FR-50** — Every `sync` and `rebuild` records its outcome, finished or failed, where `doctor` reads it.

### 2.9 Scheduling and plugin

- **FR-51** — `agent install` writes a launchd agent that runs `sync` every 15 minutes and at login, logging to the state directory, and prints the command that loads it. A run with nothing to change says so.
- **FR-52** — Replacing an existing, different launchd agent first keeps a backup copy of it.
- **FR-53** — The Claude Code plugin starts `sync` in the background whenever a session starts, resumes, clears or compacts, and adds a note telling the agent to search the record before acting on a handoff or plan.
- **FR-54** — The plugin does nothing when `agent-record` is not on PATH.

### 2.10 Edge cases

- **FR-55** — Only one `sync` or `rebuild` runs at a time. A second is refused, naming the process that holds the record.
- **FR-56** — A lock left by a process that has ended is taken over, not refused.
- **FR-57** — Queries and `sql` read while a `sync` writes, without waiting for it to finish.
- **FR-58** — A read that cannot start because another process holds the record is refused, naming that cause, not reported as a fault.
- **FR-59** — A query or `sql` against a record that does not exist is refused, naming `agent-record sync`, and creates nothing.
- **FR-60** — A Codex token record that claims more cached input than input is skipped as malformed.

### 2.11 Mirror

The archive holds the only copy of sessions a tool has deleted, so `sync` keeps a second copy of it, the mirror, in a folder a backup service carries off the machine.

- **FR-61** — The mirror folder is `~/Library/Mobile Documents/com~apple~CloudDocs/agent-record/`, in iCloud Drive, unless `AGENT_RECORD_MIRROR` names an absolute path, which then is the mirror folder.
- **FR-62** — Every `sync` copies each archive file that its mirror copy lacks, or that differs from its mirror copy in size or modification time, into the mirror's `archive/`, at the same path relative to the archive, so the mirror holds what the archive held when that `sync` ran.
- **FR-63** — No `sync` loses what a mirror copy holds: it deletes no mirror copy, so a file the archive no longer holds, such as a Codex rollout the archive moved (FR-5), keeps its mirror copy; and before it replaces a mirror copy with a smaller archive file, an empty one included, it first sets the copy aside beside it under a name no other file has, and never empties a copy without that.
- **FR-64** — When the mirror folder's parent does not exist, as when iCloud Drive is off or a volume is not mounted, `sync` writes nothing there, reads its sessions as usual, and its result says the mirror is unreachable.
- **FR-65** — A file that cannot be mirrored does not stop the sync: the other files are mirrored, and the sync's result lists the failure with its fix (FR-11).
- **FR-66** — A `sync` that mirrored every archive file without a failure records, in the mirror folder, when it did.
- **FR-67** — No command reads a session from the mirror: `rebuild` reads the archive alone (FR-24).
- **FR-68** — The mirror check warns when the mirror folder's parent does not exist or cannot be read, when no `sync` has yet mirrored the whole archive, or when the last `sync` that did finished more than a day ago, and its detail names the mirror folder.
- **FR-69** — A `sync` whose record write fails still mirrors the archive before it reports the failure.

### 2.12 Signals

The signals count the friction the owner feels, so a change to the workflow can be checked against them. Each is read from the transcripts the record holds, except those of §2.13, which read the hook event log. These terms hold for every signal:

- **Owner message**: what the owner typed into a top-level session. In Claude Code, a user message the transcript marks as human (or as typed or queued, before Claude Code marked who wrote it), and the `[Request interrupted by user]` marker; in Codex, a typed user message in a session `codex exec` did not run; in Grok, pi and omp, every user message. A slash command, a shell escape and their output are not owner messages, and a subagent session holds none.
- **Task**: a top-level session and its subagents, from a task prompt to the next one. A task prompt is the session's start, or an owner message that comes after the agent has said something and is not an interrupt (FR-70).
- **Commit run** and **push run**: a git run (FR-13) of `commit` or `push` whose tool call did not fail, at the time its result came back. It counts in the repo the record holds for the checkout its directory lies in, the innermost when checkouts nest; one outside every checkout the record indexes (FR-19) is not counted. A **commit** stays what `repo_commit` holds.
- **On origin**: a commit run is on origin from the first push run in its repo at or after it, in any session. A push the owner ran outside every session is not seen.
- **Repo**: the record's repo (FR-19), shown with its label. A commit run counts in its own repo, and a task that made one in the repo of its last; an owner message, a reviewer run and a task that made none count in the repo of the top-level session's project.
- **Route**: the stem of the first file under `skills/task/references/` that a tool call of the task's sessions read; `none` when they read none.
- **Week**: Monday to Sunday in UTC, named by its Monday.

Requirements:

- **FR-70** — The `owner-interrupts` signal counts each owner message that answers, corrects or unblocks an agent, tagged by the first cause that fits: `stop`, the interrupted marker; `answer`, the last 300 characters of what the agent last said before it hold a question mark; `correct`, it opens with a word that pushes back (no, don't, stop, wait, actually, instead, why, not, wrong, undo, revert, but, isn't, shouldn't); `unblock`, it is under 80 characters and opens with a go-ahead (yes, yep, yeah, ok, okay, sure, go ahead, proceed, continue, approve, approved, lgtm, do it, ship it, push, commit). A word matches whole, case aside, and its apostrophe may be left out. An owner message before the agent has said anything, or one no cause fits, is a task prompt instead. A tool call the owner rejected at a permission prompt counts as `permission`. Its value is interrupts per task, over the tasks of the top-level sessions the owner typed in.
- **FR-71** — The `time-to-land` signal takes each task that made a commit run, at its task prompt, and the minutes until the task's last commit run was on origin. Its value is the median minutes over the tasks that landed; a task not landed is counted apart.
- **FR-72** — The `stranded-work` signal takes each commit run an hour older than the record's newest message, and counts it stranded when it was not on origin within the hour. A session, with its subagents, whose last commit run was never on origin is counted apart: the transcript does not say when a session is archived, so a session that ended with its last commit run unpushed stands in for it. Every commit run counts, accepted by a reviewer or not: the transcripts before the hook event log (§2.13) do not say. Its value is the share of commit runs stranded.
- **FR-73** — The `review-loops` signal counts the reviewer runs, the subagent sessions whose agent type names a reviewer, and the commit runs. Its value is reviewer runs per commit run. It reaches back past the hook event log's start; `review-returns` (FR-80) counts the verdicts themselves. Fix and Consider counts and the rules cited are in the reviewer's report, which no signal reads yet.
- **FR-74** — `query signal <name>` returns, per week, the signal's value, the count behind it, what it is out of, and the count of each cause or kind. `--by repo` or `--by route` splits each week by repo or by route; `--by week` is the default. Weeks are newest first, and a week, repo or route that nothing fell in is absent, not zero. An unknown signal or `--by` is refused, naming the choices.
- **FR-75** — `query signal-events <name>` lists each message, task, commit run, reviewer run, hook event or skill load the signal counted, newest first, with its time, kind, repo, route, its minutes where the signal times it, the session `thread` opens, and the owner's words for an interrupt.
- **FR-76** — `query before-after <sha>` finds the commit in the record by a prefix of its SHA and compares each signal over the `--days <n>` days (14 by default) before the commit's time with the same span after it. `--from <ts>`, a time as FR-40 reads it, starts the after window at that time instead, when the change took effect later than its commit, such as when a hook it replaced was removed. The after window ends at the record's newest message. For each signal it returns its value before and after, with the count behind each and what it is out of, so windows of different lengths compare. A prefix that matches no commit or more than one, a `--days` that is not a whole number of at least 1, and a `--from` before the commit are refused.

### 2.13 Hook events

The cniska-skills plugin's hooks append one JSON line per decision to `events.jsonl` in the plugin's data folder (agent-skills `hooks/events.md`): commit and verdict gate decisions, reviewer verdicts, permission prompts and auto-mode denials. The hooks never write the record's formats; agent-record archives the log as one more source and reads it at ingest. The log begins when the plugin first wrote it, so a signal of this section counts nothing before then, and a `before-after` window that lies before it reads no event.

- **FR-77** — `sync` archives `events.jsonl` from the data folder of every cniska-skills plugin install, `~/.claude/plugins/data/cniska-skills-<marketplace>/`, into the archive's `plugin-data/` at the same path relative to `~/.claude/plugins/data/`, as it archives a session file: new bytes are added (FR-2), a deleted log keeps its archive copy (FR-3), and a log shrunk or rewritten, as a reinstalled plugin starts it again, gets a fresh copy while its earlier copy stays beside it as `events-<n>.jsonl`, the first number free, and its events are the record's under that new name: the log is the only record of past gate decisions. The mirror carries it with the rest of the archive (FR-62), and `rebuild` reads it again (FR-24, FR-25, FR-26).
- **FR-78** — The record holds each line of an archived log as one hook event: its file and line, time, kind, session, agent, working directory, and the fields its kind carries. Only complete new lines are read (FR-8, FR-9). A line that is not a JSON object of format version 1, and a version 1 line of a kind the record keeps (`gate`, `verdict`, `permission_prompt`, `permission_denied`) that lacks a field its kind requires or whose `gate`, `decision` or `verdict` lies outside the values `hooks/events.md` lists, is skipped and reported with its file and line (FR-10); a version 1 line of another kind is skipped without a report. `reason`, `tool` and `rule` are free text, so a new reason code is read, and a field the format adds is ignored.

Terms for the signals of this section, beside those of §2.12. "Before", "after" and "between" follow the lines in time order, then by file and line, since the log's times are to the second.

- **Hook event's place**: its top-level session is the session the line names, a subagent's line included. It counts in the record's repo of the checkout its `repo` lies in, and in no repo when that path lies in no checkout the record indexes; a line with no `repo` counts in the repo of its session's project. Its route is its task's (§2.12). `sync` reads each `repo` a line names as a checkout, as it reads a session's working directory (FR-19), so a worktree a hook named counts in its repo while it is still on disk.
- **Denial**: a `gate` line whose decision is `deny`.
- **Stop**: a denial, unless the same session and agent's previous `gate` or `verdict` line was a denial of the same gate, reason and `repo`: an agent that runs the same refused command again meets one stop.
- **Reviewed commit**: a commit-gate `allow`, of any reason, before which an `accept` verdict for its `repo` was recorded in its top-level session since that session's previous commit-gate `allow` in the same `repo`. A retried commit, or one no reviewer accepted, is no reviewed commit. Repos here are the paths the lines name.

Requirements:

- **FR-79** — The `false-stops` signal judges each stop and counts it a false stop when the work went on with nothing a gate checks changed. A stop after which its top-level session has no line in the log is pending, listed and not judged until one follows. A commit-gate stop that carries a fingerprint (`not_accepted`, `changed_since_accept`) is upheld: the gate compared the diff, and only a recorded accept lifts it. One that carries none is a false stop when the same session and agent's next commit-gate `allow` in the stop's `repo` (their next in any repo, when the stop names none) has no verdict for its `repo` recorded in any session between the two: the agent only ran the command again. A verdict-gate stop is never a false stop, since the reviewer's report did lack what the gate checks: it is `unfixed` when the same session and agent's next `gate` or `verdict` line is the verdict gate's `allow`, and upheld otherwise. Every other commit-gate stop is upheld. A false stop is tagged by its gate and reason, as `commit repo_unclear`, and is counted by that tag: a judged stop whose tag begins with a gate's name. It is never counted as the judged stops left over after the other judgements, so a judgement added later is not counted as a false stop unnoticed. Its value is the share of judged stops that were false stops. An owner's override, by committing in a terminal or through a shell escape, writes no line, so a stop it overrode is judged by the lines that follow it like any other. An auto-mode denial is not a stop and is not judged, since the log does not say whether the owner then allowed the call.
- **FR-80** — The `review-returns` signal takes each reviewed commit and the `return` verdicts for its `repo` in its top-level session since that session's previous commit-gate `allow` in the same `repo`, its returns. Its value is returns per reviewed commit; one more than a commit's returns is its rounds to accept. A return no reviewed commit follows is not counted.
- **FR-81** — The `blocks` signal counts each block by its source: a `permission prompt`, an `auto-mode denial`, a `commit gate` denial and a `verdict gate` denial, each denial counted, a repeated one too. Its value is blocks per task, over the tasks of Claude Code top-level sessions given at or after the record's first hook event and the blocks raised in those tasks; a block in a task given before the log began is not counted.
### 2.14 Skill versions

A version of a skill is its body's hash (FR-17), with the plugin install it was loaded from. Whether a version helped is read from the signals of §2.12 and §2.13 over the tasks that loaded the skill.

- **FR-82** — The `skill-usage` signal counts each skill load (FR-17), a subagent's preload too, in the task of its top-level session, and names it by its skill and version: the first 8 characters of its body's hash and its install, `-` for either the load does not carry. Its value is loads per task, over every task.

## 3. Non-functional requirements

- **NF-1** — agent-record needs no network and no credential, and sends nothing off the machine itself: the mirror is a folder on this machine that a backup service, such as iCloud Drive, may carry off it (FR-61).
- **NF-2** — A sync that finds nothing new reads no session file, copies no bytes into the archive or the mirror, and reads no checkout again.
- **NF-3** — On APFS, the first archive copy of a file takes no space of its own.
- **NF-4** — No command leaves the record half-written: a file's rows and its cursor are written together or not at all.
- **NF-5** — No command crashes with an uncoded error on a common failure: a missing record, a busy record, a held lock, an unreadable or unwritable file, a missing git, a malformed tool file.

## 4. Out of scope

- Reading sessions from another machine, or sharing a record.
- Writing to a tool's files, or to the record through `sql`.
- Semantic or embedding search; `search` matches words.
- Judging quality: `prior-art` ranks by recency and commit count only.
- Restoring the git history of a checkout no longer on disk (FR-23).
- Any platform but macOS.
- Keeping earlier versions of a mirror copy, other than the one set aside when a smaller archive file replaces it (FR-63).
- A command that restores the archive from the mirror; `README.md` documents the copy back.

## 5. Acceptance criteria

- **AC-1** — Run `sync` over fixture homes for all five tools: each session is in the archive and the record, with its facts, messages, turns, token counts, tool calls with their git runs and the directory each ran in, and skill loads. (FR-1, FR-6, FR-7, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18)
- **AC-2** — Append lines to a fixture transcript, one without a trailing newline, and sync again: only the complete new lines are added. (FR-2, FR-8, FR-9)
- **AC-3** — Delete a tool's fixture file and sync: the session stays in the record. Then `rebuild`: it is still there. (FR-3, FR-24, FR-25)
- **AC-4** — Rewrite a fixture transcript shorter and sync: the session holds only the new content. (FR-4)
- **AC-5** — Move a Codex rollout into `archived_sessions` and sync: one copy in the archive, one session in the record. (FR-5)
- **AC-6** — Change a tool's fixture file after archiving it, then `rebuild` from the archive alone: the record matches the archive, not the tool's file. (FR-7)
- **AC-7** — Sync a fixture of each tool holding a malformed line, with an unreadable file and an orphan subagent: the sync finishes, and its report names each malformed line, the failure with its fix, and the orphan. (FR-10, FR-11, FR-12)
- **AC-8** — Sync with a fixture session in a fixture git repo with an origin remote, and in a repo under a temp directory: the first repo's commits with their types, its label and its files are recorded, the temp repo's are not; a second sync with no change reads neither. (FR-19, FR-20, FR-21, FR-22)
- **AC-9** — Sync fixtures, then `rebuild`: the session, message, turn, usage, tool-call, git-run and skill-load rows are identical. (FR-26)
- **AC-10** — Set the record's schema version lower, then higher: `sync`, `query` and `sql` each refuse, naming `agent-record rebuild` and a newer agent-record respectively; `rebuild` succeeds on the lower one. (FR-24, FR-27, FR-28, FR-29)
- **AC-11** — Run each command once successfully and once with bad input, and `doctor` with a failing check: the successful runs and `doctor` print `ok: true` on stdout, `doctor` exiting 1; the bad input prints `ok: false` on stderr with exit 1, and the error carries kind, code, message, meta and resolve. (FR-30, FR-31)
- **AC-12** — Run `agent-record` alone, an unknown command, and each malformed argument form: the listing and each refusal with its usage. (FR-32, FR-33)
- **AC-13** — `query list`, an unknown query, `--rows 0`, and a query with more rows than the default: listing, refusals, and the `more` note. (FR-34, FR-35, FR-36)
- **AC-14** — `search` for words in a said message, in a skill body, and in no message, with more distinct words than it searches: the said message ranks by matched words, the skill body is absent, the unmatched and dropped words are named, and a hit's reference opens in `thread`. (FR-35, FR-37, FR-38, FR-39)
- **AC-15** — `thread` on a whole session, around a time, with an ambiguous prefix, and with an unknown prefix: rows in order, the counts outside the stretch, the refusal naming matches, and an empty result with its note. (FR-40, FR-41, FR-44)
- **AC-16** — `prior-art` over fixture repos with a worktree and more matching files per repo than it ranks: matches folded onto the checkout, newest first, and the denominator saying only some were ranked. (FR-42)
- **AC-17** — `sql` with a SELECT, an INSERT, a syntax error, a column named twice and a blob: columns and rows as a query prints them, a `sql_writes` refusal, a `sql_invalid` refusal with SQLite's reason, a `sql_columns_repeated` refusal naming the column, and a `sql_blob` refusal naming `hex()`. (FR-43)
- **AC-18** — `doctor` with no record, a busy record, a stale sync stamp, a failed sync, a sync with failed files, and each launchd agent state: each check's state and fix, and exit 1 exactly when one fails. (FR-45, FR-46, FR-47, FR-48, FR-49)
- **AC-19** — A `sync` that succeeds, one with failed files and one that fails: each leaves an outcome `doctor` reads. (FR-50)
- **AC-20** — `agent install` with no agent, the same agent, and a different one: written with the loading command, unchanged, and replaced with a backup. (FR-51, FR-52)
- **AC-21** — Run the plugin hook with and without `agent-record` on PATH: it starts `sync` and prints the note, or does nothing. (FR-53, FR-54)
- **AC-22** — Start a second `sync` while one holds the lock: it is refused naming the holder. Leave a lock from an ended process: the next `sync` takes it. (FR-55, FR-56)
- **AC-23** — Query while a writer holds a write transaction: the query answers. Hold the record exclusively: the query is refused as busy. (FR-57, FR-58)
- **AC-24** — `query` and `sql` with no record: refused naming `agent-record sync`, and no file is created. (FR-59)
- **AC-25** — A Codex token record with more cached input than input: skipped and reported as a dropped line. (FR-60)
- **AC-26** — Sync with the network unavailable: it succeeds. (NF-1)
- **AC-27** — Sync fixtures with an iCloud Drive folder in the home, then sync again with nothing changed: the second report reads no file, archives no bytes, mirrors no file, and counts every checkout unchanged. (NF-2)
- **AC-28** — A sync whose record write fails after it archived a file leaves the record as the sync before left it; the next sync records the file once, from where the last committed write left it. (NF-4)
- **AC-29** — Each failure in NF-5 produces a refusal with a code and fix, never `command_failed`. (NF-5)
- **AC-30** — On APFS, sync a large session file: the archive holds a copy, and the volume's free space drops by far less than the file's size. (NF-3)
- **AC-31** — Sync with a fixture repo, delete the repo, sync, then `rebuild`: the sync keeps its commits, the rebuild has none. (FR-23)
- **AC-32** — Sync fixtures with no `AGENT_RECORD_MIRROR` and an iCloud Drive folder in the home: every archive file is in the iCloud Drive mirror with the archive's bytes. Append to a fixture transcript and sync: its mirror copy matches the archive's again. Sync with `AGENT_RECORD_MIRROR` set: the archive is mirrored there instead. (FR-61, FR-62)
- **AC-33** — Move a Codex rollout into `archived_sessions` and sync: the mirror holds the rollout at both its old and its new path. (FR-63)
- **AC-34** — Sync fixtures with an iCloud Drive folder, then empty one fixture transcript and rewrite another shorter, and sync again: each mirror copy holds what the archive now holds, and the copy each replaced is set aside beside it with the content it held. (FR-63)
- **AC-35** — Sync with no iCloud Drive folder in the home: the sync succeeds, its result says the mirror is unreachable, nothing is created at the mirror path, and `doctor` warns that the mirror is unreachable. (FR-64, FR-68)
- **AC-36** — Sync with a mirror copy that cannot be written: the sync succeeds, the other files are mirrored, its result lists the failure with its fix, and `doctor` warns that the archive was never mirrored whole; fix the copy and sync: `doctor` passes the mirror. (FR-65, FR-66, FR-68)
- **AC-37** — Plant a session in the mirror that the archive lacks, then `rebuild`: the record does not hold it. (FR-67)
- **AC-38** — `doctor` after a sync that mirrored the archive, and with a mirror time over a day old: the mirror check passes, then warns, naming the mirror folder. (FR-45, FR-68)
- **AC-39** — Sync with an iCloud Drive folder and a record of another schema version: the sync is refused, and the archive is mirrored. (FR-69)
- **AC-40** — Sync a session in which the owner opens a task, answers a question, pushes back, says go ahead, interrupts, rejects a permission and asks a new task, with a subagent: `signal owner-interrupts` counts one of each cause over two tasks and nothing from the subagent, and `signal-events owner-interrupts` lists them. (FR-70, FR-75)
- **AC-41** — Sync sessions in a fixture repo where one task commits and pushes, one commits after a `cd` into the repo and is pushed later from another session, and one never pushes: `signal time-to-land` gives the median minutes of the two landed tasks and one task not landed. (FR-71)
- **AC-42** — Sync a session with a commit run pushed within the hour, one pushed after it, and a last commit run never pushed: `signal stranded-work` counts two stranded commit runs of three, and one session ended unpushed. (FR-72)
- **AC-43** — Sync a session with two reviewer subagents and one commit run: `signal review-loops` gives two reviewer runs per commit run. (FR-73)
- **AC-44** — `signal` by week, with `--by repo`, `--by route`, an unknown signal and an unknown `--by`: rows per week, split by repo with its label and by route, and two refusals naming the choices. (FR-74)
- **AC-45** — `before-after` on a fixture commit with sessions on both sides, with `--from` given to the second and to the minute, and with an unknown SHA, a `--days 0`, a `--from` before the commit and a `--from` with no offset: each signal's value before and after with its counts, the after window starting at `--from` either way, and four refusals. (FR-40, FR-76)
- **AC-46** — Sync a fixture home with an event log in two cniska-skills installs and an `events.jsonl` in another plugin's folder, the log holding a line of each kept kind, a malformed `gate` line, a version 2 line and a line of an unknown kind: each cniska-skills log is in the archive under `plugin-data/` and in the mirror, the other plugin's is in neither, `sql` returns one hook event per good line with its fields, and the sync reports the malformed and version 2 lines and not the unknown one. Append a line and sync: only it is read. Delete both logs and `rebuild`: the record holds the same hook events. Write one log again with one new line and sync: the record holds those events and the new one. (FR-26, FR-77, FR-78)
- **AC-47** — Sync a log in which a `repo_unclear` denial with no repo is repeated and then followed by the same agent's `allow`, a `repo_not_found` denial by an accept verdict for a repo and that agent's `allow` there, a `changed_since_accept` denial by an accept and an `allow` of its fingerprint, a `gate_error` denial in one repo by that agent's `allow` in another and then in its own, a verdict-gate denial by the same reviewer's verdict-gate `allow`, another by that reviewer's verdict, and a last `multiple_commits` denial: `signal false-stops` counts two false stops of six judged stops, tagged `commit repo_unclear` and `commit gate_error`, with one `unfixed` and one `pending`, and `signal-events false-stops` lists all seven stops. (FR-79)
- **AC-48** — Sync a log in which one session's repo gets two `return` verdicts, an accept and an `accepted` commit-gate `allow` tried twice, then a Markdown-only change with one return, an accept and a `no_code_change` `allow`, then an `allow` no reviewer accepted, then a trailing return: `signal review-returns` gives 1.5 returns per reviewed commit, three returns over two reviewed commits. (FR-80)
- **AC-49** — Sync a session whose first task was given before its log began, with a permission prompt in it, and whose next two came after, holding a permission prompt, an auto-mode denial, a commit-gate denial and a verdict-gate denial, beside an earlier session from before the log: `signal blocks` gives two blocks per task, four blocks over two tasks, one of each source. (FR-81)
- **AC-50** — Sync a session that loads a plugin skill twice through the Skill tool, once with arguments appended to its body, and whose subagent preloads another, beside a later session that loads a changed body of the first from a newer install: `signal skill-usage` gives three loads in the first week's one task, two of one version, and one in the next week's. (FR-17, FR-82)

## 6. Deliverables

- **D-1** — The `agent-record` CLI, run by Bun from a checkout and linked onto PATH by `mise install`.
- **D-2** — The `cniska-record` Claude Code plugin in `plugin/`.
- **D-3** — `README.md` (install, commands, where the record and its mirror live, and how to restore the archive from the mirror), `AGENTS.md` (repository rules), `src/README.md` (module map), and this spec.
- **D-4** — The test suite, run by `bun run check`, and the acceptance suite in `acceptance/`, run by `bun run acceptance`. The acceptance suite drives only the CLI, and reaches past it only in two files. `acceptance/cli.ts` plants or reads state no command makes or reports without waiting real time (the record's schema version, the last-sync stamp, the mirror's time, a held lock, a held record) or stands in for the OS (a `launchctl` on PATH). `acceptance/cli-no-wait.ts` runs the CLI with no wait for a held record, so a busy record is refused at once.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun.
- **C-2** — The record is one SQLite database under `$XDG_DATA_HOME/agent-record/`, beside the archive.
- **C-3** — Local only: no server, no network, no account.
- **C-4** — The archive is the source of truth for sessions; the session record is derived from it and can always be rebuilt. The mirror is a copy of the archive, never a source.
- **C-5** — Every command's output is one JSON line, for agents to read.

## 8. Open decisions (left to the builder)

- The record's tables and columns, provided FR-13 holds and a table change bumps the schema version (FR-27).
- How the archive detects that a file grew, shrank, was rewritten or moved (bounded by FR-2, FR-4, FR-5).
- How sync tells a checkout is unchanged (bounded by FR-22), and how far back a changed checkout's commits are re-read (bounded by FR-19).
- Which locations count as scratch (bounded by FR-21).
- The default row count, the number of words `search` takes, the files per repo `prior-art` ranks, and the stale-sync threshold, provided each result says what it cut (FR-36, FR-39, FR-42, FR-47).
- How search ranks within equal matched-word counts (bounded by FR-37).
- How long a command waits for a held record before it is refused (bounded by FR-58, NF-5).
- The shape of the reference `search` gives and `thread` takes (bounded by FR-37, FR-40).
- The signals' thresholds and word lists, and `before-after`'s default span, provided each is stated where the signal is defined (FR-70 to FR-73, FR-76).

### Policies chosen (not open)

- `ok` in a command's output means the command ran; a judgement it makes, such as `doctor`'s, is in its result and its exit code (FR-30, FR-49).
- A busy record is a `fail` in `doctor`, not a `warn` (FR-46).
- A busy record is SQLite reporting the database held; a race for agent-record's own lock is a separate refusal (FR-55, FR-58).
- The launchd agent's 15-minute interval is promised to the user (FR-51).
- An unreachable or stale mirror is a `warn` in `doctor`, not a `fail`: the record still works without it (FR-68).
- The mirror keeps only the archive, not the record: the record is rebuilt from the archive (FR-24).

## 9. Open questions and known gaps

Each requirement still needs the owner's confirmation before it is contract.

Known gaps, where the code does not yet meet a requirement:

- **Not every criterion is proven yet.** A criterion with a passing test in the acceptance suite, which drives only the CLI, is proven; the rest are todos there. `src/spec.test.ts` ties the suite to this spec. The unit tests stay unit tests and cite no ID.
- **FR-33.** `query` given a flag where the query name goes refuses it as an unknown query, not an unknown flag.
- **FR-4.** A rewrite that keeps a file's size and modification time is not detected.
