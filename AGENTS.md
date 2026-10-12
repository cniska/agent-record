# agent-record

A local record of coding-agent sessions and the queries over it. [`README.md`](README.md) lists the commands; [`src/README.md`](src/README.md) maps the modules.

## Rules

- `bun run check` is the check: lint, typecheck and tests. It passes before every commit.
- The record carries one schema version as `PRAGMA user_version` (`src/db-schema.ts`). A change to the tables bumps it; every reader and writer refuses another version and names `agent-record rebuild` as the repair.
- Ingest reads only the archive (`src/ingest-archive.ts`), never a tool's own files, so `rebuild` loses nothing a tool has since deleted.
- Fix the cause, never work around it, and add no debt.
- Code carries no comments, tool contracts aside. A why goes into a name, a test, or this file.
- Commit directly to `main`. `.githooks/commit-msg` judges the message: one Conventional Commit subject, ASCII, at most 50 characters, and no body.
