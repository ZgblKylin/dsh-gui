/**
 * The connection tab bar chrome: tabs in the title area (one per connected DSH
 * backend), a hamburger menu (switch / new / close), a "＋" new-connection
 * page, and iframe content hosting the active backend's frontend.
 *
 * State (tabs, active index, saved connections) is kept in localStorage, so
 * dsh-gui restarts restore the same connection set. Everything host-side is
 * reached through POST /remote-api/<op>.
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type Host = PropsRuntime<'shell.overlay'>

const LS_CONNS = 'dsh.remote.connections.v1'
const LS_TABS = 'dsh.remote.tabs.v1'
const LS_ACTIVE = 'dsh.remote.active.v1'

interface Conn {
  id: string
  type: 'local' | 'remote'
  name: string
  port: number
  address?: string
  sshUser?: string
  sshHost?: string
  sshPort?: number
  url?: string
}

interface Tab {
  id: string
  kind: 'connection' | 'new'
  connId?: string
  title?: string
  url?: string
}

interface LogLine {
  step: string
  ok: boolean
  detail?: string
}

/** POST to the host op and return the JSON body. */
async function rpc(op: string, args: unknown): Promise<any> {
  const res = await fetch(`/remote-api/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  })
  return res.json()
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}
function saveJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}
function uid(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function currentPort(): number {
  try { return Number(window.location.port) || 3080 } catch { return 3080 }
}
function currentOrigin(): string {
  try { return window.location.origin } catch { return 'http://127.0.0.1:3080' }
}
function bufferToB64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf)
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)))
  return btoa(s)
}

export function RemoteApp(_props: Host) {
  const [connections, setConnections] = useState<Conn[]>(() => loadJSON<Conn[]>(LS_CONNS, []))
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const initial = loadJSON<Tab[]>(LS_TABS, [])
    if (initial.length > 0) return initial
    return [{ id: uid(), kind: 'connection', connId: 'current', title: '本机', url: currentOrigin() }]
  })
  const [activeId, setActiveId] = useState<string | null>(() => loadJSON<string | null>(LS_ACTIVE, null))
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => { saveJSON(LS_TABS, tabs) }, [tabs])
  useEffect(() => { saveJSON(LS_ACTIVE, activeId) }, [activeId])
  useEffect(() => { saveJSON(LS_CONNS, connections) }, [connections])
  useEffect(() => { rpc('env', {}).catch(() => { /* offline */ }) }, [])

  const activeTab = tabs.find(t => t.id === activeId) ?? tabs[0]
  const current = currentOrigin()

  const openNewTab = (): void => {
    const t: Tab = { id: uid(), kind: 'new' }
    setTabs(prev => [...prev, t])
    setActiveId(t.id)
    setMenuOpen(false)
  }

  const closeTab = (id: string): void => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) {
        const fresh: Tab = { id: uid(), kind: 'new' }
        setActiveId(fresh.id)
        return [fresh]
      }
      if (activeId === id) {
        const idx = prev.findIndex(t => t.id === id)
        setActiveId(next[Math.min(idx, next.length - 1)].id)
      }
      return next
    })
    setMenuOpen(false)
  }

  const switchTab = (id: string): void => { setActiveId(id); setMenuOpen(false) }
  const toMenu = (t: Tab): string => (t.kind === 'new' ? '＋ 新建连接' : (t.title ?? t.connId ?? '标签'))

  const addConnectionTab = (conn: Conn, url: string): void => {
    const t: Tab = { id: uid(), kind: 'connection', connId: conn.id, title: conn.name, url: conn.url ?? url }
    setConnections(prev => prev.some(c => c.id === conn.id) ? prev : [...prev, conn])
    setTabs(prev => {
      const replaced = prev.map(x => (x.id === activeId && x.kind === 'new') ? t : x)
      return replaced.some(x => x.id === t.id) ? replaced : [...replaced, t]
    })
    setActiveId(t.id)
    setMenuOpen(false)
  }

  const isTransparent = activeTab !== undefined && activeTab.kind === 'connection' && activeTab.url === current

  return (
    <div className="rm-root" data-transparent={isTransparent || undefined}>
      <div className="rm-bar">
        <button type="button" className="rm-hamburger" onClick={() => setMenuOpen(o => !o)} title="菜单">☰</button>
        {menuOpen && (
          <div className="rm-menu">
            <div className="rm-menu-title">标签页</div>
            {tabs.map(t => (
              <div key={t.id} className={'rm-menu-item' + (t.id === activeId ? ' active' : '')} onClick={() => switchTab(t.id)}>
                {toMenu(t)}
              </div>
            ))}
            <div className="rm-menu-sep" />
            <div className="rm-menu-item" onClick={openNewTab}>新建连接</div>
            {activeTab !== undefined && <div className="rm-menu-item" onClick={() => closeTab(activeTab.id)}>关闭当前连接</div>}
          </div>
        )}
        <div className="rm-tabs">
          {tabs.map(t => (
            <div key={t.id} className={'rm-tab' + (t.id === activeId ? ' active' : '')} onClick={() => switchTab(t.id)}>
              <span>{toMenu(t)}</span>
              <span className="rm-x" onClick={e => { e.stopPropagation(); closeTab(t.id) }}>×</span>
            </div>
          ))}
        </div>
        <button type="button" className="rm-plus" onClick={openNewTab} title="新建连接">+</button>
      </div>
      <div className="rm-body">
        {activeTab !== undefined && activeTab.kind === 'new' && (
          <NewConnection currentPort={currentPort()} onConnect={addConnectionTab} />
        )}
        {tabs.filter(t => t.kind === 'connection').map(t => (
          t.id === activeId && t.url !== current
            ? <iframe key={t.id} className="rm-iframe" src={t.url} title={t.title} />
            : null
        ))}
      </div>
    </div>
  )
}

function NewConnection(props: { currentPort: number; onConnect: (conn: Conn, url: string) => void }) {
  const { onConnect } = props
  const [type, setType] = useState<'local' | 'remote'>('local')
  const [name, setName] = useState('')
  const [port, setPort] = useState(String(props.currentPort))
  const [address, setAddress] = useState('')
  const [sshOn, setSshOn] = useState(false)
  const [sshUser, setSshUser] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState<string | null>(null)
  const [saveAuth, setSaveAuth] = useState(true)
  const [status, setStatus] = useState<LogLine[]>([])
  const [busy, setBusy] = useState(false)

  const pushStatus = (s: LogLine): void => setStatus(prev => [...prev, s])
  const makeConn = (): Conn => ({
    id: uid(),
    type,
    name: name.trim(),
    port: Number(port),
    ...(type === 'remote' ? {
      address: address.trim().replace(/^https?:\/\//i, ''),
      sshUser: sshUser.trim() || undefined,
      sshHost: sshHost.trim() || undefined,
      sshPort: Number(sshPort) || undefined,
    } : {}),
  })

  const doConnect = async (): Promise<void> => {
    setBusy(true)
    setStatus([])
    try {
      if (type === 'local') await connectLocal()
      else await connectRemote()
    } catch (e) {
      pushStatus({ step: '连接失败', ok: false, detail: String(e instanceof Error ? e.message : e) })
    } finally {
      setBusy(false)
    }
  }

  const connectLocal = async (): Promise<void> => {
    const p = Number(port)
    if (name.trim() === '') { pushStatus({ step: '校验', ok: false, detail: '请填写连接名' }); return }
    if (!Number.isInteger(p) || p <= 0 || p > 65535) { pushStatus({ step: '校验', ok: false, detail: '端口无效' }); return }
    const url = `http://127.0.0.1:${p}/`
    const conn = { ...makeConn(), url }
    pushStatus({ step: `检查端口 ${p}`, ok: false, detail: url })
    const probe = await rpc('probe', { url })
    if (probe.ok === true) {
      pushStatus({ step: '端口可加载', ok: true, detail: `HTTP ${probe.status}` })
      onConnect(conn, url)
      return
    }
    pushStatus({ step: '端口不可加载，启动内置 dsh', ok: false, detail: probe.error ?? '' })
    const started = await rpc('local.start', { port: p })
    if (started.ok !== true) { pushStatus({ step: '启动失败', ok: false, detail: started.error ?? '' }); return }
    pushStatus({ step: '等待后端就绪', ok: false, detail: `pid ${started.pid ?? '?'}` })
    const deadline = Date.now() + 60000
    let okProbe: any = null
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000))
      okProbe = await rpc('probe', { url })
      if (okProbe.ok === true) break
    }
    if (okProbe !== null && okProbe.ok === true) {
      pushStatus({ step: '后端就绪', ok: true, detail: `HTTP ${okProbe.status}` })
      onConnect(conn, url)
    } else {
      pushStatus({ step: '超时', ok: false, detail: '后端未在 60s 内启动' })
    }
  }

  const connectRemote = async (): Promise<void> => {
    const p = Number(port)
    const addr = address.trim().replace(/^https?:\/\//i, '')
    if (name.trim() === '') { pushStatus({ step: '校验', ok: false, detail: '请填写连接名' }); return }
    if (addr === '') { pushStatus({ step: '校验', ok: false, detail: '请填写地址' }); return }
    if (!Number.isInteger(p) || p <= 0 || p > 65535) { pushStatus({ step: '校验', ok: false, detail: '端口无效' }); return }
    const url = `http://${addr}:${p}/`
    const conn: Conn = { ...makeConn(), address: addr, url }
    pushStatus({ step: `检查 ${url}`, ok: false })
    const probe = await rpc('probe', { url })
    if (probe.ok === true) {
      pushStatus({ step: '远端可加载', ok: true, detail: `HTTP ${probe.status}` })
      onConnect(conn, url)
      return
    }
    pushStatus({ step: '远端不可加载，尝试 ssh 部署', ok: false, detail: probe.error ?? '' })
    if (!sshOn) { pushStatus({ step: '需要 ssh', ok: false, detail: '请开启 SSH 部署并配置认证' }); return }

    let sshConn: Record<string, unknown> = {
      address: addr,
      port: p,
      sshUser: sshUser.trim() || undefined,
      sshHost: sshHost.trim() || undefined,
      sshPort: Number(sshPort) || undefined,
      password: password || undefined,
      keyFile: keyPath,
    }
    // No typed credential: reuse a saved one first, else let the host try the
    // ~/.ssh/config alias; only when the host reports authRequired do we ask
    // the user for credentials directly here.
    if (!sshConn.password && !sshConn.keyFile) {
      const savedCred = await rpc('creds.read', { name: name.trim() })
      if (savedCred.exists === true && savedCred.payload) {
        const pl = savedCred.payload as { sshUser?: string; sshHost?: string; password?: string; keyFile?: string; sshPort?: number }
        sshConn.sshUser = sshConn.sshUser || pl.sshUser
        sshConn.sshHost = sshConn.sshHost || pl.sshHost
        sshConn.password = pl.password
        sshConn.keyFile = pl.keyFile
        sshConn.sshPort = sshConn.sshPort || pl.sshPort
        pushStatus({ step: '使用已保存认证', ok: true, detail: name.trim() })
      }
    }
    if (!sshConn.sshUser && !sshConn.password && !sshConn.keyFile && !sshConn.sshHost) {
      pushStatus({ step: '缺少认证', ok: false, detail: '请填写 SSH 用户名（或 SSH 主机别名）与密码/密钥' })
      return
    }

    const res = await rpc('ssh.connect', { conn: sshConn })
    for (const s of (res.log ?? [])) pushStatus(s as LogLine)
    if (res.ok === true) {
      if (saveAuth && (password !== '' || keyPath !== null || sshHost.trim() !== '')) {
        await rpc('creds.save', {
          name: name.trim(),
          payload: {
            sshUser: sshConn.sshUser,
            sshHost: sshConn.sshHost,
            password: password || undefined,
            keyFile: keyPath ?? undefined,
            sshPort: sshConn.sshPort,
          },
        })
      }
      onConnect(conn, res.url ?? url)
    } else if (res.authRequired === true) {
      pushStatus({ step: '回退到连接配置', ok: false, detail: '该主机需要认证（SSH 别名无法免密）——请填写 SSH 用户名、密码或密钥文件（二选一），或勾选保存认证' })
    }
  }

  const onPickKey = (file: File | null): void => {
    if (file === null) return
    const reader = new FileReader()
    reader.onload = async (): Promise<void> => {
      try {
        pushStatus({ step: '上传密钥', ok: false, detail: file.name })
        const b64 = bufferToB64(reader.result as ArrayBuffer)
        const w = await rpc('keyfile.write', { name: name.trim() || 'key', b64 })
        if (w.ok === true) {
          setKeyPath(w.path)
          pushStatus({ step: '密钥已保存', ok: true, detail: w.path })
        } else {
          pushStatus({ step: '密钥保存失败', ok: false, detail: w.error ?? '' })
        }
      } catch (e) {
        pushStatus({ step: '密钥读取失败', ok: false, detail: String(e instanceof Error ? e.message : e) })
      }
    }
    reader.readAsArrayBuffer(file)
  }

  return (
    <div className="rm-new">
      <div className="rm-new-inner">
        <h2>新建连接</h2>
        <div className="sub">连接到另一个 DSH 后端：本机端口加载/启动，或通过 SSH 部署到远端。</div>
        <div className="rm-type-grid">
          <div className={'rm-type-card' + (type === 'local' ? ' sel' : '')} onClick={() => setType('local')}>
            <b>本地连接</b>
            <small>在本机端口加载或启动 DSH 前端</small>
          </div>
          <div className={'rm-type-card' + (type === 'remote' ? ' sel' : '')} onClick={() => setType('remote')}>
            <b>远程连接</b>
            <small>加载远端，必要时通过 SSH 部署</small>
          </div>
        </div>
        <div className="rm-row">
          <div className="rm-field">
            <label>连接名</label>
            <input className="rm-input" value={name} onChange={e => setName(e.target.value)} placeholder="例如：办公机" />
          </div>
          <div className="rm-field">
            <label>端口</label>
            <input className="rm-input" value={port} onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="3080" />
          </div>
        </div>
        {type === 'remote' && (
          <div className="rm-field">
            <label>地址（不含 http://）</label>
            <input className="rm-input" value={address} onChange={e => setAddress(e.target.value)} placeholder="192.168.1.10" />
          </div>
        )}
        {type === 'remote' && (
          <label className="rm-check">
            <input type="checkbox" checked={sshOn} onChange={e => setSshOn(e.target.checked)} />
            需 SSH 部署（端口不可加载时使用）
          </label>
        )}
        {type === 'remote' && sshOn && (
          <div className="rm-row">
            <div className="rm-field">
              <label>SSH 主机（别名，如 ASUS；留空用上面的地址）</label>
              <input className="rm-input" value={sshHost} onChange={e => setSshHost(e.target.value)} placeholder="ASUS 或 192.168.1.10" />
            </div>
            <div className="rm-field">
              <label>SSH 用户名（留空用 ssh config 的 User）</label>
              <input className="rm-input" value={sshUser} onChange={e => setSshUser(e.target.value)} placeholder="root / chongfei" />
            </div>
          </div>
        )}
        {type === 'remote' && sshOn && (
          <div className="rm-field">
            <label>SSH 端口（留空用 ssh config / 默认 22）</label>
            <input className="rm-input" value={sshPort} onChange={e => setSshPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="22" />
          </div>
        )}
        {type === 'remote' && sshOn && (
          <div className="rm-field">
            <label>密码 或 密钥文件（二选一；密钥在此上传）</label>
            <input className="rm-input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="SSH 密码（留空则用密钥）" />
            <div style={{ marginTop: 8 }}>
              <input type="file" onChange={e => onPickKey(e.target.files?.[0] ?? null)} />
            </div>
          </div>
        )}
        {type === 'remote' && sshOn && (
          <label className="rm-check">
            <input type="checkbox" checked={saveAuth} onChange={e => setSaveAuth(e.target.checked)} />
            保存认证（Windows 凭据管理器 / Linux gpg）
          </label>
        )}
        <div style={{ marginTop: 18 }}>
          <button type="button" className="rm-btn" disabled={busy} onClick={() => { void doConnect() }}>{busy ? '连接中…' : '连接'}</button>
        </div>
        {status.length > 0 && (
          <div className="rm-log">
            {status.map((s, i) => (
              <div key={i} className={s.ok ? 'ok' : 'err'}>
                {(s.ok ? '✓ ' : '✗ ') + s.step + (s.detail !== undefined ? ' — ' + s.detail : '')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
