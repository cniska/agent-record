# Uninstall

How to remove agent-record: the launchd agent, the plugin, the CLI, its state and its data.

1. If you ran `agent-record agent install`, unload the launchd agent, then remove its plist and the backup copies of it beside it:

   ```bash
   launchctl bootout gui/$(id -u)/dev.agentrecord.sync
   rm -f ~/Library/LaunchAgents/dev.agentrecord.sync.plist*
   ```

2. Remove the plugin: `claude plugin uninstall cniska-record@cniska`.
3. Remove the CLI the way it was installed:
   - **curl:** `rm ~/.local/bin/agent-record`, and the `export PATH` line the installer added to your `~/.zshrc`, `~/.bashrc` or `~/.bash_profile`, if it added one.
   - **Homebrew:** `brew uninstall agent-record`.
   - **npm:** `npm uninstall -g @cniska/agent-record`.
   - **bun:** `bun remove -g @cniska/agent-record`.
   - **From source:** `bun unlink` in the clone, then delete the clone.
4. Remove `~/.local/state/agent-record/` (`$XDG_STATE_HOME/agent-record/` when that is set), which holds the sync log, the last-sync stamp and the locks.
5. The data folder and the mirror hold the archive, which may be the only copy left of transcripts the tools have deleted: copy them elsewhere first if you may want those sessions. Then remove the data folder, `~/.local/share/agent-record/` (`$XDG_DATA_HOME/agent-record/` when that is set), and the [mirror](mirror.md), `agent-record/` in iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/agent-record/`, or the folder `$AGENT_RECORD_MIRROR` names when that is set).
