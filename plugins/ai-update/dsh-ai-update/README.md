# dsh-ai-update — AI update bridge for the dsh-gui shell

A tiny browser-half harness plugin. The dsh-gui desktop shell's update dialog
has "AI 更新" buttons; clicking one posts a "dsh-gui:ai-update" window message
into the embedded dsh web page, and this plugin prepares the ready-to-send
session WITHOUT creating one itself and WITHOUT picking an agent preset:

1. returns the page to the new-session home (the empty hero screen);
2. selects the target workspace there (preferring the dsh-gui repository
   workspace, then the current session's workspace, then the recent or first
   workspace) — the standard workspace pick reuses the workspace's existing
   blank session, and only mints a fresh one when the workspace has none,
   exactly like clicking the workspace on the home screen;
3. opens that blank session and prefills the composer draft with the prompt
   built by the shell; the agent preset chip is left untouched so the user
   picks the preset themselves;
4. replies "dsh-gui:ai-update-result" to the parent frame so the shell can
   toast the outcome.

The plugin imports nothing from dsh-gui and only uses public client services
(sessions, workspaces, conversation), so it also works in a plain harness dsh
web deployment: any embedding parent may post the same message shape.

## Wire shape

Request (parent -> page):

    { type: 'dsh-gui:ai-update', version: 1, requestId: string, prompt: string }

prompt is the prefilled composer draft.

Result (page -> parent):

    { type: 'dsh-gui:ai-update-result', version: 1, requestId: string, ok: boolean, error?: string }

Requests from any source other than window.parent are ignored; a response is
posted to window.parent with a wildcard target origin because the shell's
origin is a Tauri custom protocol.

## Install

Installed by the dsh-gui shared plugin pipeline (plugins/ai-update/install.mjs):
build with the pinned toolchain pnpm, link the package into the web profile;
the package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it into
`dsh.profile.bundles` and its own `cordis.patch.yml` mounts it as the
"ai-update" loader entry. Restart dsh-gui (or dsh web) afterwards so the
client-module scan picks up the new entry.

## License

Unlicense.
