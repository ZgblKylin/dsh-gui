# dsh-ai-update docs

Integration notes for the dsh-gui shell.

## Why this plugin exists

The update dialog is rendered by the desktop shell (src-tauri/ui), which can
only reach the embedded harness page through postMessage. The harness web GUI
has no deep-link for "go to the new-session home, select workspace X, and
prefill Y", so the feature is split:

- shell half — renders the AI update buttons, builds the Chinese prompt from
  the update rows (module name, path, current/latest versions), posts the
  request, toasts the reply;
- plugin half — this package's browser bundle, which drives the new-session
  home through public client services.

This respects the repo rule that harness features ship as plugins: no
deepseek-harness source is modified, and the plugin itself remains a pure
harness plugin usable without dsh-gui.

## Session flow details

- The plugin clears the current selection (the home/hero screen appears),
  then performs the standard workspace pick: the target workspace prefers a
  registered workspace whose path basename is "dsh-gui" (the update prompts
  use paths relative to that repository root), then the current session's
  workspace, then the recent-workspace projection, then the first listed
  workspace.
- workspaces.connectWorkspace reuses the workspace's existing blank session;
  a fresh session is only minted when the workspace has none — the same
  behavior as clicking the workspace on the home screen. The plugin never
  calls session create directly.
- The agent preset is deliberately NOT touched: the preset chip keeps its
  default/staged choice and the user selects the preset before sending.
  agentPreset.select is therefore not part of this plugin.
- The draft is written through conversation.input.for(actx).setDraft, the
  same single-write path the composer uses; the user reviews and sends it.

## Failure handling

Every failure is carried back to the shell as an "ok: false" result message
(no workspace, service unavailable); the shell keeps the update dialog open
and toasts the message. A missing reply (plugin not installed, wrong backend)
times out in the shell after 10s.
