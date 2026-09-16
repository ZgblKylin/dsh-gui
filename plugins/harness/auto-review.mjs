/**
 * Auto review wrapper: installs the official experimental per-call LLM
 * authorization layer into the web profile.
 *
 * Source — from npm, no local package:
 *   - `@deepseek-ai/dsh-experimental-auto-review`: adds an Auto review
 *     option to the current-session permission selector. Every native call
 *     and every started PTC inner call is reviewed once by the current
 *     agent's provider/model before its body; allowed calls execute with
 *     Full access.
 *
 * The package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it
 * into `dsh.profile.bundles` and it mounts through its own bundle layer
 * (loader entry id `auto-review`); this script writes no `cordis.patch.yml`
 * insert (a manual one would double-mount it). This installer lives under
 * `plugins/harness/` — the group of official dsh-family plugins — and is
 * loaded by `plugins/harness/install.mjs`; it also runs standalone.
 *
 * The version is pinned to the harness revision this repository builds
 * against: `0.1.6-alpha.1` is the dsh-family prerelease whose peerDependencies
 * all point at `^0.1.6-alpha.1`, matching the pinned `dsh-v0.1.6-alpha.1`
 * runtime. It is also a prerelease, which is why the Community Market cannot
 * carry it.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

/** Wrapper id: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'auto-review'

const AUTO_REVIEW_SPEC = '@deepseek-ai/dsh-experimental-auto-review@0.1.6-alpha.1'

installNpmPlugin({ id: ID, packageSpec: AUTO_REVIEW_SPEC })