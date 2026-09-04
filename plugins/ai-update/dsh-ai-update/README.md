# dsh-ai-update — AI update bridge for the dsh-gui shell

A tiny browser-half harness plugin. The dsh-gui desktop shell's update dialog
has "AI 更新" buttons; clicking one posts a "dsh-gui:ai-update" window message
into the embedded dsh web page, and this plugin prepares the ready-to-send
session WITHOUT creating one itself:

1. returns the page to the new-session home (the empty hero screen);
2. selects the target workspace there (preferring the dsh-gui repository
   workspace, then the current session's workspace, then the first
   workspace) — the standard workspace pick reuses the workspace's existing
   blank session, and only mints a fresh one when the workspace has none,
   exactly like clicking the workspace on the home screen;
3. opens that blank session and auto-selects the 「创造模式」(creator) preset
   for it via `ctx.remote.agentPresets.select(sessionId, 'cordis')` — the
   same selection the hero chip's pick and the settings creator-draft entry
   make — so the AI-update work runs under the creator's composition
   (runtime inspection, plugin experiments, preset authoring guidance). A
   refusal fails the request instead of silently running under another
   preset; the user may still change the preset chip before sending.
4. prefills the composer draft with the prompt built by the shell;
5. replies "dsh-gui:ai-update-result" to the parent frame so the shell can
   toast the outcome.

The plugin imports nothing from dsh-gui and only uses public client services
(sessions, workspaces, uiWorkspace, conversation, and the `remote.agentPresets`
namespace), so it also works in a plain harness dsh web deployment: any
embedding parent may post the same message shape.

## Wire shape

Request (parent -> page):

    { type: 'dsh-gui:ai-update', version: 1, requestId: string, prompt: string }

prompt is the prefilled composer draft.

Result (page -> parent):

    { type: 'dsh-gui:ai-update-result', version: 1, requestId: string, ok: boolean, error?: string }

Requests from any source other than window.parent are ignored; a response is
posted to window.parent with a wildcard target origin because the shell's
origin is a Tauri custom protocol.

## Changelog summary route (host half)

The update dialog's 「更新日志」 button asks, for a commit target (or a tag
whose GitHub release notes are unavailable), a summary of the commit range.
The shell (`src-tauri/src/changelog.rs`) builds the prompt from the collected
commit list and POSTs it to this plugin's host route:

    POST /dsh-gui-api/changelog  { prompt }  →  { ok: true, text } | { ok: false, error }

The host half runs `ctx.llm.stream` with the web profile's default model
(`ctx.agentDefaultModel.currentSelection()`). No Agent and no Session is
created, so the run never appears in the DSH session list — the same approach
dsh-sidebar-qa's summarize route uses for its side conversations. The route
sits behind the same browser-trust fence as the /api gateway (loopback
Host-header or the connection row's `trustedHosts`); the shell's loopback
client carries no cross-site markers, so it passes like the /remote-api calls
do. The route is only registered when the web runtime services are present
(`ctx.inject(['webServer', 'llm', 'agentDefaultModel', 'loader'], …)`), so the
plugin stays inert in base-only/headless deployments. When the route is
unavailable, the shell falls back to the harness's one-shot headless run —
that degraded path redirects its session store to a temp directory, so it
also never leaves a session in the DSH session list.

## Install

Installed by the dsh-gui shared plugin pipeline (plugins/ai-update/install.mjs):
build with the pinned toolchain pnpm, link the package into the web profile;
the package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it into
`dsh.profile.bundles` and its own `cordis.patch.yml` mounts it as the
"ai-update" loader entry. Restart dsh-gui (or dsh web) afterwards so the
client-module scan picks up the new entry.

## License

Unlicense.
