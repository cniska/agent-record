# src/

Flat, so a module is found by name. A file's prefix is its module: `db-read.ts` belongs to `db`, `ingest-sync.ts` to `ingest`. A module that is one file carries its bare name (`paths.ts`, `worktree.ts`). A test sits beside its module as `<module>.test.ts`; a file ending in `.test-support.ts` is shared by tests only.

Two of a module's files are named for their layer:

| File | Holds |
| --- | --- |
| `<module>-contract.ts` | Its types and refusals, what other modules import |
| `<name>-command.ts` | The one `agent-record` command `<name>`: parse the arguments, call the module, return the result |

The rest are named by the step they take (`ingest-parse-claude.ts`, `ingest-archive.ts`, `query-thread.ts`). Another module reaches one only through its contract, its commands and the files it publishes; any other file of it, such as `ingest-git.ts`, is its own ([`modules.test.ts`](modules.test.ts)). A test reaches another module the same way; a `.test-support.ts` fixture may reach any file. Of the files that are not tests, only `cli-commands.ts` imports a command.

## Modules

| Prefix | Responsibility |
| --- | --- |
| `ingest` | Copy session files into the archive, and read them from there and git history into the record |
| `sync`, `rebuild` | The commands that run ingest, and the stamp a sync leaves |
| `agent` | Install the launchd agent that syncs on a schedule, and read whether it is loaded |
| `db` | Open, lock and read the SQLite record, and its schema |
| `doctor` | Judge the record's readability and freshness, the launchd agent, and the mirror |
| `mirror` | Copy the archive into the mirror folder, and read when it last held the whole archive |
| `query`, `sql` | The named queries over the record, and raw read-only SQL |
| `git`, `repo`, `worktree` | Run git, index a repo's files, and fold worktree paths onto their checkout |
| `plugin` | Tests for the Claude Code plugin's hook in `plugin/`, kept here so the plugin ships no tests |
| `spec` | Tie the IDs in `SPEC.md` to the acceptance suite's test names |
| `modules` | Hold each module to the files it publishes |
| `cli` | Dispatch a command and print its result or error (a refusal or a fault) as one JSON line |
| `coded-error`, `error`, `assert`, `env`, `paths`, `file`, `timestamp` | Coded errors, refusals and faults; reading a code, a message or an errno off a thrown value; `unreachable` and `invariant`; the environment, parsed once by `cli.ts`; where every file lives; copying a file aside before it is replaced, and copying one over a stale copy; parsing a time into its canonical UTC text |

## Terms

- **checkout**: a git worktree's directory on disk (`checkout.path`, `repo_file.checkout`).
- **repo**: what every worktree of one git common directory shares, named by that directory's parent, which is the main checkout when the git directory is its `.git` (`repo_commit.repo`).
- **project**: a session's `cwd`, cut at the Claude worktree segment when it lies inside one (`session.project`).
- **label**: a repo's `owner/name`, read from `remote.origin.url` (`repo_commit.label`).

## Where to start

- `cli-commands.ts` lists the commands, each loaded only when it runs; `cli-contract.ts` is what one is.
- `db-schema.ts` holds the record's tables.
- `ingest-sources.ts` lists the session sources; `ingest-parse-<tool>.ts` reads one tool's files.
- `query-registry.ts` lists the named queries; `query-signals.ts` lists the signals they count.
- Read a module's `.test.ts` before changing its contract, and `modules.test.ts` before publishing a file.
