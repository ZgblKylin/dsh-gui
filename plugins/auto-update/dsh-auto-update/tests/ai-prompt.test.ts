/**
 * Unit tests for the AI-update prompt builder's npm plugin rows.
 *
 * The builder is pure and type-only in its dependencies, so it runs under plain
 * Node without the Cordis runtime. The npm row prompt must carry the facts the
 * skill cannot know: the package, its install script, the current pin, the
 * registry target, and the requirement to update the script itself.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { UpdateProject } from '../src/client/api.ts'
import { aiEligibleProjects, buildAiUpdatePrompt } from '../src/client/ai-prompt.ts'

/** One npm plugin row as the host half produces it. */
function npmRow(overrides: Partial<UpdateProject> = {}): UpdateProject {
  return {
    id: 'npm:@max-null/dsh-skill-mcp-center',
    name: '@max-null/dsh-skill-mcp-center',
    path: 'plugins/skill-mcp-center/install.mjs',
    current: '0.7.0',
    latest: '0.7.1',
    behind: true,
    announce: true,
    checking: false,
    kind: 'npm',
    packageName: '@max-null/dsh-skill-mcp-center',
    installScript: 'plugins/skill-mcp-center/install.mjs',
    ...overrides,
  }
}

/** One git row, used to prove the two kinds coexist in a batch prompt. */
const harnessRow: UpdateProject = {
  id: 'deepseek-harness',
  name: 'deepseek-harness',
  path: 'deepseek-harness',
  current: 'v0.2.0',
  latest: 'v0.2.1',
  latestTag: 'v0.2.1',
  latestTagStale: false,
  behind: true,
  announce: true,
  checking: false,
}

test('an npm row prompt names the package, script, pin and target', () => {
  const prompt = buildAiUpdatePrompt([npmRow()], () => 'commit')
  for (const fragment of [
    '@max-null/dsh-skill-mcp-center',
    'plugins/skill-mcp-center/install.mjs',
    '0.7.0',
    '0.7.1',
    'packageSpec',
  ]) {
    assert.ok(prompt.includes(fragment), `prompt is missing ${fragment}`)
  }
})

test('npm rows are AI-eligible without the tag rules', () => {
  const eligible = aiEligibleProjects([npmRow({ announce: false })])
  assert.deepEqual(eligible.map((row) => row.id), ['npm:@max-null/dsh-skill-mcp-center'])
})

test('a batch groups git rows and npm rows in one prompt', () => {
  const prompt = buildAiUpdatePrompt([harnessRow, npmRow()], () => 'tag')
  assert.ok(prompt.includes('deepseek-harness'))
  assert.ok(prompt.includes('plugins/skill-mcp-center/install.mjs'))
})

test('the root row stays out of the AI flow', () => {
  const root: UpdateProject = {
    id: 'dsh-gui',
    name: 'dsh-gui',
    path: '',
    current: 'v1.0.0',
    latest: 'v1.1.0',
    latestTag: 'v1.1.0',
    latestTagStale: false,
    behind: true,
    announce: true,
    checking: false,
  }
  assert.deepEqual(aiEligibleProjects([root, npmRow()]).map((row) => row.id), [npmRow().id])
})
