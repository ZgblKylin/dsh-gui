# dsh-ai-update docs

Integration notes for the dsh-gui shell.

## Why this plugin exists

The update dialog is rendered by the desktop shell (src-tauri/ui), which can
only reach the embedded harness page through postMessage. The harness web GUI
has no deep-link for "go to the new-session home, select workspace X, and
prefill Y", so the feature is split:

- shell half — renders the AI update buttons for submodule rows, builds the
  Chinese prompt from the update rows (module name, path, current/latest
  versions), posts the request, toasts the reply; the top-level dsh-gui row
  has no AI update — its 「更新」 button runs a live in-dialog git update
  (see below);
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

## Prompt composition

The shell builds the prefilled prompt in `src-tauri/ui/app.js`
(`buildAiUpdatePrompt`). `deepseek-harness` gets a dedicated prompt: it is
the engineering base (the harness itself, at the repository root) and not a
plugin, so its prompt never references the `plugins/` layout or the plugin
install pipeline — after the git fast-forward it first assesses the impact
of the update on the current dsh-gui project (features/config/dependencies
and adaptation points), and only then routes the rebuild through the
repository build script (`node scripts/dsh-gui.mjs build`) and its own
harness documentation. Such a
prompt always closes with a quick-audit step: every unmasked plugin install
script (`plugins/<id>/install.mjs`; entries carrying a `MASKED` guard, such
as `terminal` and `file-explorer`, are skipped) is checked against the
official spec the updated harness just pinned (repository-root AGENTS.md,
`docs/official/`, and the dsh-plugin-install skill). Batch prompts include
this audit only when `deepseek-harness` is among the updated modules.

Batch AI update (`AI 更新全部`) special-cases the base modules:

- dsh-gui in the batch: the other updates are ignored and the flow is
  equivalent to clicking the top-level row's 「更新」 (in-dialog root
  update, no prompt is posted);
- deepseek-harness only: the dedicated harness prompt above;
- deepseek-harness plus plugins: a merged prompt — harness update
  (impact check before the rebuild) first, then the plugin modules, then
  the compatibility audit (`buildHarnessAuditStep`), then the report.

## Top-level project update (no AI)

The top-level dsh-gui row deliberately has no AI update button: clicking its
「更新」 runs `update_root` (Rust) in place — the root fast-forwards to the
selected target and `git submodule update --init --recursive` syncs every
submodule to the commits the new root revision records — while the dialog
streams progress via `update-root-log` events. The shell keeps running and
nothing is rebuilt: on completion the dialog reminds the user to re-run
`npm run build` for the full rebuild and then restart dsh-gui.

The detached update launcher (`src-tauri/src/update_script.mjs`) recursively
syncs nested submodules after EVERY project it moves (root first, then the
individually-behind submodules), so a subproject carrying secondary
submodules is brought in sync too.

## Failure handling

Every failure is carried back to the shell as an "ok: false" result message
(no workspace, service unavailable); the shell keeps the update dialog open
and toasts the message. A missing reply (plugin not installed, wrong backend)
times out in the shell after 10s.
