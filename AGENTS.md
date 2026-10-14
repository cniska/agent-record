# agent-record

A local record of coding-agent sessions and the queries over it. [`SPEC.md`](SPEC.md) states what must hold and changes in the same commit as the behavior it describes; [`README.md`](README.md) lists the commands; [`src/README.md`](src/README.md) maps the modules.

## Rules

- `bun run check` is the check: lint, typecheck and tests. It passes before every commit.
- The record carries one schema version as `PRAGMA user_version` (`src/db-schema.ts`). A change to the tables bumps it; every reader and writer refuses another version and names `agent-record rebuild` as the repair.
- Ingest reads only the archive (`src/ingest-archive.ts`), never a tool's own files, so `rebuild` loses nothing a tool has since deleted.
- Fix the cause, never work around it, and add no debt.
- A bug fix lands with a test watched failing first.
- No test waits real time: a wait or a clock is passed in, as `now` is.
- Code carries no comments. `.githooks/pre-commit.d/no-comments` refuses a comment a commit adds, other than a directive a tool reads. A why goes into a name, a test, or this file.
- Commit directly to `main`. `.githooks/commit-msg` judges the message: one Conventional Commit subject, ASCII, at most 50 characters, and no body.
- Push each commit to `main` once `bun run check` passes and a fresh reviewer accepts it; that accept is the owner's standing sign-off, so no push waits on them.
