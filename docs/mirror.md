# Mirror

The copy of the archive every `sync` keeps off the machine, and how to restore the archive from it.

Once a tool deletes a transcript, the archive holds its only copy. Every `sync` therefore mirrors the archive into `~/Library/Mobile Documents/com~apple~CloudDocs/agent-record/archive/`, in iCloud Drive, which carries it off the machine.

Set `AGENT_RECORD_MIRROR` to an absolute path to mirror into `$AGENT_RECORD_MIRROR/archive/` instead. The launchd agent does not see a variable set in your shell, so it mirrors to the default.

## What a sync mirrors

- A sync copies each archive file that is new or changed since the last; it never deletes a mirror copy, so a file the archive moved stays at its old path too. Before a smaller or empty archive file replaces a mirror copy, the old copy is set aside beside it as `<name>.agent-record-backup` (then `-2`, `-3`, ...).
- A sync whose record write fails still mirrors the archive.
- The mirror keeps the archive only. The record is rebuilt from the archive, and no command reads the mirror.
- When the mirror folder's parent is missing, as when iCloud Drive is off, a sync mirrors nothing and says so in its `mirror` result; the sessions are read as usual.
- `agent-record doctor` warns when the mirror is out of reach, has never held the whole archive, or was last brought up to date more than a day ago.

## Restore the archive

First stop anything that syncs: `launchctl bootout gui/$(id -u)/dev.agentrecord.sync` for the launchd agent, and Claude Code sessions start a sync too. Have iCloud download the folder (in Finder, Download Now on `agent-record` in iCloud Drive), then copy it back and rebuild:

```bash
mkdir -p ~/.local/share/agent-record
ditto ~/Library/Mobile\ Documents/com~apple~CloudDocs/agent-record/archive ~/.local/share/agent-record/archive
agent-record rebuild
```

`ditto` adds to an archive that is still partly there and replaces the files both hold with the mirror's copy, so restore into an empty archive unless you mean that. A Codex rollout the archive moved comes back at both its paths; the record still holds its session once.
