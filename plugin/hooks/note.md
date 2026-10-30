# agent-record

`agent-record` holds every past coding-agent session on this machine: what was said, decided and done.

- A handoff, plan or memory is a snapshot. Before acting on one, search the record for what was decided after it: `agent-record query search "<words>"`, then `agent-record query thread` on a hit, as the search result says. A later decision wins.
- When the owner says "we agreed" or "check the record", search it before answering from memory.
- Run `agent-record sync` before the first query: the sync this session started may still be running. If it is refused `lock_held`, search anyway and say the record may lag one sync. Never retry or wait for it.
- `agent-record query prior-art "<path fragment>"` finds where a shape already exists on disk, and `agent-record sql "<select>"` reads anything else; `agent-record query list` and `agent-record --help` name the rest.
