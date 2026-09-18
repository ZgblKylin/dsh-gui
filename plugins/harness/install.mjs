/**
 * Harness plugins wrapper: installs every official dsh-family plugin as one
 * flat group.
 *
 * `plugins/harness/` holds only plugins that ship with the dsh project
 * (`@deepseek-ai/dsh-*` packages). Each plugin's install logic is its own flat
 * `.mjs` installer in this directory; this first-level entry runs them in
 * order. Loading an installer is that install: each ends with its top-level
 * install calls, and each also runs standalone.
 */

import './agent-team.mjs'
import './auto-review.mjs'
import './browser-use.mjs'