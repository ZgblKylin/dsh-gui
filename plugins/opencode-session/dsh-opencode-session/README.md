# dsh-opencode-session

Injects the OpenCode per-conversation `x-opencode-session` header on LLM
requests that the agent loop does not stamp, so every request to the pi-ai
`opencode` / `opencode-go` routes carries the header the OpenCode gateway now
requires.

## Problem

Since 2026-09-05 OpenCode Go enforces `x-opencode-session` on every inference
request ([docs](https://opencode.ai/docs/go/#where-can-i-use-it)). The agent
loop already stamps `GenerateOptions.sessionId` on conversation requests
(`packages/core/agent-loop/src/agent.ts`), which the pi-ai opencode adapters
turn into the header. Hand-built auxiliary calls omit it — the
`experimental-auto-review` gate is the visible one, and its review prompt fails
with:

```
400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. ..."}
```

Upstream tracking: [deepseek-ai/deepseek-harness#5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495).

## How it works

Registers a `prepend` listener on the `llm/stream` waterfall
(`packages/llm/dsh-llm`). When a request targets an OpenCode provider and has
no `sessionId`, it re-dispatches `ctx.llm.stream({ ...options, sessionId })`;
the injected request re-enters the waterfall with its session id set and passes
straight through to the adapter, so other listeners still run exactly once.

The injected id is the initiating conversation's DSH session id, recovered with
`ctx.agents.currentInitiator()` — the same value the loop stamps. Tool
execution runs inside the initiator scope, so the auto-review review call (made
from its `tools/pre-execute` listener) attributes to its parent conversation.

## Why reuse the conversation session id (no cache fork)

`x-opencode-session` is a per-conversation routing/affinity hint, not a stateful
session object: it pins consecutive requests of one conversation to the same
backend so prefix-based prompt caching hits. Prompt caches are content-addressed
by token prefix, so a divergent auxiliary request only misses its own prefix —
it does not evict the conversation's cached prefix.

- Official guidance: a **stable session id per conversation**, applied to
  **all** outbound inference requests
  ([opencode/docs/go](https://opencode.ai/docs/go/#where-can-i-use-it);
  [deepseek-harness#5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495)).
- The validated reference client Hermes sends the header "on main and auxiliary
  OpenCode requests" — one id per conversation for both
  ([docs](https://opencode.ai/docs/go/#where-can-i-use-it);
  [PR #101864](https://github.com/NousResearch/hermes-agent/pull/101864)).
- Harness's own compaction auxiliary calls already stamp
  `sessionId: agent.session.id`
  (`packages/compaction/compaction-basic/src/summarizer.ts`).
- A separate id would split affinity and was called "cache misses, slower &
  pricier" ([prior art](https://github.com/beihzb/dsh-opencode-session-header)).

If you later observe cache-hit degradation and prefer isolation, set
`sessionIdMode: 'per-call'` (below) — no code change needed.

## Config

```yaml
- id: opencode-session
  name: dsh-opencode-session
  config:
    providers: [opencode, opencode-go]   # routes that require the header
    sessionIdMode: conversation           # conversation | per-call
    fallbackSessionId: null               # optional stable id when unattributed
```

- `providers` — provider routes whose requests get the header. Default the
  pi-ai `opencode` and `opencode-go` routes. Commands / session config can add a
  custom gateway route.
- `sessionIdMode` — `conversation` (default) reuses the initiating
  conversation's id; `per-call` gives each unattributed request a fresh id.
- `fallbackSessionId` — stable id used when no initiator attributes the request
  (`ctx.agents.currentInitiator()` is `undefined`). Defaults to a
  process-stable uuid, so a request is never sent headerless.

## Install / mount

In-tree plugin (`plugins/opencode-session/`); it declares `dsh.bundle.patch` and
mounts through its own bundle layer, so `dsh plugin add` reconciles it into
`dsh.profile.bundles` and no manual `cordis.patch.yml` insert is written.

```sh
# web profile
npm run plugins

# desktop profile (the desktop app's CLI; the app must be quit first)
npm run build:desktop -- --plugins-only
```

Then restart dsh. Verify the loader entry appears and the profile's
`dsh.profile.bundles` lists `dsh-opencode-session`.

## Tests

```sh
pnpm run build   # tsdown -> lib/index.js
pnpm test        # node:test over the built injector decision function
```

## Known limitations & retirement

- Requests that already carry `sessionId` (conversation loop) and non-OpenCode
  providers are strictly passed through; the plugin never rewrites them.
- This is a stopgap: once upstream ships per-conversation session headers on
  every adapter path (discussion
  [#5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495)),
  the plugin becomes a no-op and can be removed
  (`dsh plugin --profile <profile> remove dsh-opencode-session`, restart).
- Prior art (not used here): `dsh-opencode-session-header` patches global
  `fetch` (beihzb) and `dsh-opencode-session` (brackrat); this plugin uses the
  official `llm/stream` seam and needs no transport patching.