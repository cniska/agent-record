# Claude Code Plugin

The `cniska-record` plugin in `plugin/`, in the `cniska` marketplace, is the preferred way to keep the record current and point every session at it.

Whenever a Claude Code session starts, resumes, clears or compacts, it:

- starts `agent-record sync` in the background, so the record stays current;
- adds a short note to the session, `plugin/hooks/note.md`, on when and how to search the record.

The plugin brings neither Bun nor the CLI, and does nothing when `agent-record` is not on PATH. Install the CLI first, as the [README](../README.md#install) says.

The launchd agent (`agent-record agent install`) is the alternative for keeping the record current while Claude Code is not running.
