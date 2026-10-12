import { test } from "bun:test";

test.todo("AC-1 a sync records every tool's sessions with their facts, turns, tokens, tool calls and skill loads", () => {});
test.todo("AC-2 a second sync adds only the complete lines appended since the first", () => {});
test.todo("AC-3 a session whose tool file is deleted stays in the record through sync and rebuild", () => {});
test.todo("AC-4 a transcript rewritten shorter holds only its new content after sync", () => {});
test.todo("AC-5 a Codex rollout moved into archived_sessions stays one archive copy and one session", () => {});
test.todo("AC-6 a rebuild reads the archive, not a tool file changed since it was archived", () => {});
test.todo("AC-7 a sync over a malformed line, an unreadable file and an orphan finishes and names each", () => {});
test.todo("AC-8 a sync records a session repo's commits, label and files, skips a temp repo, and rereads neither", () => {});
test.todo("AC-9 a rebuild yields the rows the sync wrote", () => {});
test.todo("AC-22 a second sync is refused naming the lock holder, and a lock from an ended process is taken", () => {});
test.todo("AC-25 a Codex token record with more cached input than input is reported as a dropped line", () => {});
test.todo("AC-26 a sync succeeds with the network unavailable", () => {});
test.todo("AC-27 a sync with nothing changed reads no file, archives no bytes and finds every checkout unchanged", () => {});
test.todo("AC-28 a sync after an interrupted one resumes the file from its last whole write without duplicates", () => {});
test.todo("AC-31 a fresh archive copy on APFS adds no allocated blocks", () => {});
test.todo("AC-32 a sync keeps a deleted repo's commits and a rebuild has none", () => {});
