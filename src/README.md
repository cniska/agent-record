# src/

Flat, so a module is found by name. A file's prefix is its module: `db-read.ts` belongs to `db`, `ingest-sync.ts` to `ingest`. A test sits beside its module as `<module>.test.ts`; a file ending in `.test-support.ts` is shared by tests only.

## Modules

| Prefix | Responsibility |
| --- | --- |
| `ingest`, `sync`, `rebuild`, `agent` | Copy session files into the archive, read them from there and git history into the record, on the schedule the launchd agent sets |
| `db` | Open, lock and read the SQLite record, and its schema |
| `doctor` | Judge the record's readability and freshness, and the launchd agent |
| `query`, `sql` | The named queries over the record, and raw read-only SQL |
| `git`, `repo`, `worktree` | Run git, index a repo's files, and fold worktree paths onto their checkout |
| `plugin` | Tests for the Claude Code plugin's hook in `plugin/`, kept here so the plugin ships no tests |
| `cli` | Dispatch a command and print its result or error (a refusal or a fault) as one JSON line |
| `coded-error`, `error`, `assert`, `paths`, `pid`, `file` | Coded errors, refusals and faults; `unreachable` and `invariant`; where every file lives; whether a process is alive; copying a file aside before it is replaced |

## Where to start

- `cli-commands.ts` lists the commands, each loaded only when it runs; `cli-contract.ts` is what one is.
- `db-schema.ts` holds the record's tables.
- `ingest-sources.ts` lists the session sources; `ingest-parse-<tool>.ts` reads one tool's files.
- `query-registry.ts` lists the named queries.
