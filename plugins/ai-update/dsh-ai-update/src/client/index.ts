/**
 * dsh-ai-update browser half — the AI update bridge for the dsh-gui desktop
 * shell.
 *
 * The shell's update dialog posts "dsh-gui:ai-update" messages into the
 * embedded page (a synthetic window message dispatched at document top level,
 * where window.parent === window). This plugin does NOT create a session by
 * itself and does NOT pick an agent preset. It:
 *
 *  1. validates the request (type + version + requestId + prompt),
 *  2. returns the page to the new-session home (sessions.clear),
 *  3. selects the dsh-gui project directory there — the standard workspace
 *     pick: uiWorkspace.connectWorkspace reuses the workspace's existing
 *     blank session (a fresh one is only minted when the workspace has none,
 *     exactly like clicking the workspace on the home screen) and opens it,
 *  4. prefills the composer draft with the prompt, leaving the agent preset
 *     chip untouched so the user picks the preset themselves,
 *  5. replies to window.parent with "dsh-gui:ai-update-result" so the shell
 *     can toast success/failure.
 *
 * Everything goes through public client services (sessions, workspaces,
 * uiWorkspace, conversation input resolver); no dsh-gui module is imported.
 */

const REQUEST_TYPE = 'dsh-gui:ai-update'
const RESULT_TYPE = 'dsh-gui:ai-update-result'
const PROTOCOL_VERSION = 1

/** Wire shape the shell sends. */
interface AiUpdateRequest {
  type: 'dsh-gui:ai-update'
  version: number
  requestId: string
  prompt: string
}

/** Wire shape answered to window.parent. */
interface AiUpdateResult {
  type: 'dsh-gui:ai-update-result'
  version: number
  requestId: string
  ok: boolean
  error?: string
}

interface SessionSummaryLike {
  id: string
}

interface SessionsLike {
  list: {
    getSnapshot(): { current?: string; ids: string[]; byId: Record<string, SessionSummaryLike> }
  }
  clear(): void
  open(id: string): void
  scope(id: string): unknown | undefined
}

interface WorkspaceViewLike {
  workspaceId: string
  sessionIds: string[]
  path?: string
}

interface WorkspacesLike {
  list: {
    getSnapshot(): { items: WorkspaceViewLike[] }
  }
}

/** Workspace navigation service (owns the standard new-session workspace pick). */
interface UiWorkspaceLike {
  connectWorkspace(workspaceId: string): Promise<string>
}

/** Public per-session input face (the draft write the shell wants). */
interface SessionInputLike {
  setDraft(text: string): void
}

interface ConversationLike {
  input: {
    for(actx: unknown): SessionInputLike
  }
}

/** Structural client context — services resolved lazily via ctx.get. */
interface ClientCtxLike {
  get(name: 'conversation'): ConversationLike
  get(name: 'sessions'): SessionsLike
  get(name: 'workspaces'): WorkspacesLike
  get(name: 'uiWorkspace'): UiWorkspaceLike
  get(name: string): unknown
  effect(cb: () => () => void): void
}

/** Required services (cordis fiber inject). */
export const inject = ['sessions', 'workspaces', 'conversation', 'uiWorkspace']

/** Stable cordis plugin name. */
export const name = 'dsh-ai-update'

/** Validate an unknown message payload as an AI-update request. */
function isRequest(value: unknown): value is AiUpdateRequest {
  if (value === null || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return data.type === REQUEST_TYPE
    && data.version === PROTOCOL_VERSION
    && typeof data.requestId === 'string'
    && typeof data.prompt === 'string' && data.prompt.trim() !== ''
}

/** Human-readable error text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reply to the embedding shell with the outcome. */
function reply(requestId: string, outcome: { ok: boolean; error?: string }): void {
  const message: AiUpdateResult = { type: RESULT_TYPE, version: PROTOCOL_VERSION, requestId, ...outcome }
  try {
    window.parent.postMessage(message, '*')
  } catch {
    // Parent gone (tab closed) — nothing left to inform.
  }
}

/** Wait briefly for the workspace list (it may still be loading on boot). */
async function ensureWorkspacesReady(workspaces: WorkspacesLike): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    const snapshot = workspaces.list.getSnapshot()
    if (snapshot.items.length > 0) return
    if (Date.now() >= deadline) throw new Error('工作区列表尚未就绪，请稍后重试')
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

/** Basename of a workspace path (both separators; trailing ones ignored). */
function basenameOf(path: string): string {
  const trimmed = path.replace(/[\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

/**
 * Pick the workspace to select on the home screen. The dsh-gui repository
 * workspace wins when registered (the update prompts use its relative paths),
 * then the current session's workspace, then the first workspace.
 */
function resolveTargetWorkspace(sessions: SessionsLike, workspaces: WorkspacesLike): string | undefined {
  const ws = workspaces.list.getSnapshot()
  const repo = ws.items.find(item => item.path !== undefined && basenameOf(item.path).toLowerCase() === 'dsh-gui')
  if (repo !== undefined) return repo.workspaceId
  const current = sessions.list.getSnapshot().current
  const currentWorkspaceId = current === undefined
    ? undefined
    : ws.items.find(item => item.sessionIds.includes(current))?.workspaceId
  return currentWorkspaceId ?? ws.items[0]?.workspaceId
}

/**
 * Run one request end to end.
 * @param request - validated shell request.
 */
async function run(ctx: ClientCtxLike, request: AiUpdateRequest): Promise<void> {
  const sessions = ctx.get('sessions')
  const workspaces = ctx.get('workspaces')
  const uiWorkspace = ctx.get('uiWorkspace')
  const conversation = ctx.get('conversation')

  await ensureWorkspacesReady(workspaces)
  const targetWorkspaceId = resolveTargetWorkspace(sessions, workspaces)
  if (targetWorkspaceId === undefined) {
    throw new Error('没有可用的工作区（请先在 dsh web 中注册 dsh-gui 项目目录）')
  }

  // Back to the new-session home first, then the standard workspace pick:
  // reuses the workspace's existing blank session (creates one only when the
  // workspace has none — the same as clicking the workspace on the home
  // screen) and opens it. The preset chip is deliberately left untouched.
  sessions.clear()
  const sessionId = await uiWorkspace.connectWorkspace(targetWorkspaceId)
  sessions.open(sessionId)

  const actx = sessions.scope(sessionId)
  if (actx === undefined) {
    throw new Error('工作区会话的作用域不可用')
  }
  conversation.input.for(actx).setDraft(request.prompt)
}

/** Mount the bridge: listen for shell requests; reply on the same channel. */
export function apply(ctx: ClientCtxLike): void {
  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data
    if (!isRequest(data)) return
    if (event.source !== window.parent) return
    void run(ctx, data).then(
      () => reply(data.requestId, { ok: true }),
      (error: unknown) => reply(data.requestId, { ok: false, error: messageOf(error) }),
    )
  }
  ctx.effect(() => {
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
}
