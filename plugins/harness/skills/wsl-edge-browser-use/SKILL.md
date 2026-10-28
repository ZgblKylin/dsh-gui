---
name: wsl-edge-browser-use
description: 在 WSL 里把 Windows 端 Edge（或 Chrome）的 CDP 调试端口经 TCP 转发暴露给 WSL，并让 dsh 的 browser-use（Playwright MCP）以 attach 模式连接，实现对带登录态的 Windows 浏览器的元素定位与页面操作。
whenToUse: 在 WSL 中运行 dsh、需要 browser-use 操作 Windows 上的 Edge/Chrome（页面快照、按元素点击、复用登录态）时使用。
---

# WSL 下用端口转发接入 Windows Edge

## 适用场景

dsh 运行在 WSL 内，浏览器是 Windows 的原生 Edge/Chrome。Windows 是主力机，浏览器里保存着登录态，直接让 agent 操作这个浏览器比在 WSL 内另起无登录态的 Chromium 更实用。

## 原理

Chromium 系浏览器的 `--remote-debugging-port` 只监听 `127.0.0.1`。WSL2 默认的 NAT 网络下，WSL 访问不到 Windows 的 loopback，因此 Playwright 的 `browserType.connectOverCDP` 无法直接连接。

解决办法是在 Windows 侧启动一个 TCP 转发器，把 `0.0.0.0:9444` 转发到 `127.0.0.1:9333`（Edge 的调试端口）。WSL 通过 Windows 的局域网地址访问这个转发器，dsh 的 browser-use 以 `mode: attach` 连接该地址。

为什么使用 Windows 的局域网地址而不是 WSL 网关地址：NAT 模式下 WSL 的默认网关 `172.24.x.1` 会随 WSL 重启变化，而 Windows 的局域网地址稳定，`attach` 的 endpoint 不需要跟着改。

## 前置条件

- Windows 侧已安装 Edge 或 Chrome。
- WSL 内的 dsh 已安装 browser-use（`plugins/harness/browser-use.mjs` 安装的 Playwright MCP provider）。
- Windows 防火墙允许 WSL 访问转发的端口。若被拦截，在 Windows 侧为端口添加允许入站的规则。

## 步骤

### 1. 在 Windows 侧启动带调试端口的 Edge

Edge 和 Chrome 从 136 版本起禁止对默认 user-data-dir 开启远程调试，必须指定独立目录。同一目录可以反复启动，登录态会保存在该目录中；首次使用时需要在这个实例里登录一次目标网站。若必须复用默认 profile 的登录态，把默认 profile 目录复制到独立目录后再启动。

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9333 `
  --user-data-dir="$env:LOCALAPPDATA\EdgeCDPProfile" `
  --no-first-run --no-default-browser-check about:blank
```

### 2. 在 Windows 侧启动 TCP 转发器

无需管理员权限。保存为 `.ps1` 后以隐藏窗口运行，或直接粘贴到 PowerShell 会话中保持运行。转发器必须常驻，Edge 重启后只要端口不变就不需要重启转发器。

```powershell
$listen = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 9444)
$listen.Start()
while ($true) {
  $client = $listen.AcceptTcpClient()
  $target = [System.Net.Sockets.TcpClient]::new()
  try {
    $target.Connect('127.0.0.1', 9333)
    $cs = $client.GetStream(); $ts = $target.GetStream()
    $cs.CopyToAsync($ts) | Out-Null
    $ts.CopyToAsync($cs) | Out-Null
  } catch { $client.Close() }
}
```

### 3. 验证 WSL 到转发器的连通性

在 WSL 内执行：

```bash
curl -s "http://<Windows 局域网地址>:9444/json/version"
```

返回包含 `Browser` 与 `Protocol-Version` 的 JSON 即表示链路可用。若使用代理环境，`no_proxy` 必须包含该 Windows 局域网地址的精确 IP；Playwright 使用的 HTTP 客户端不识别 `no_proxy` 里的 CIDR 写法。

### 4. 让 browser-use 以 attach 模式连接

在 profile 的 `cordis.patch.yml` 中把 browser-use 提供方的 `config` 改成：

```yaml
- insert:
    - id: browser-use-playwright-mcp
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: attach
        endpoint: 'http://<Windows 局域网地址>:9444'
```

重启 dsh-gui 后生效。工具名仍是 `mcp__playwright-mcp__*`，用法与 launch 模式一致：

- `browser_snapshot` 返回页面的 accessibility 树与元素 `ref`；
- `browser_click` 传 `target: <ref>`，Playwright 会生成 `getByText`、`getByRole` 等元素定位代码；
- 页面操作复用 Edge 实例的登录态。

## 注意事项

- **attach 是独占模式**。同一时间只有一个会话持有该浏览器；其他会话会以无浏览器工具的状态运行，而不是创建失败。
- **不要用默认 user-data-dir 开调试端口**。Chrome/Edge 136 起会拒绝启动远程调试。
- **代理冲突**。若 dsh 运行环境带 `http_proxy`，`no_proxy` 要包含 Windows 局域网地址的精确 IP；CIDR 写法对 Playwright 不生效，表现为 `The property 'Host in options.headers' must match the request authority` 错误。
- **Edge 进程可能杀不掉**。带调试端口启动的 Edge 在某些情况下会残留，任务管理器也无法结束，重启 Windows 可清理。排查时换用新端口与新 user-data-dir 即可继续。
- **Windows 重启后需要重跑步骤 1 和 2**。端口和设备名保持不变时，endpoint 配置不需要修改。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `curl` 连接被拒绝 | 转发器未运行，或 Edge 未带调试端口启动 | 依次检查步骤 1、2 的进程 |
| `Host ... must match the request authority` | 代理拦截了 WSL 到 Windows 地址的请求 | 在 `no_proxy` 中加入精确 IP |
| attach 成功但页面为空 | 该 user-data-dir 没有登录态 | 在该 Edge 实例中登录一次 |
| 连接超时 | Windows 防火墙拦截 | 为转发端口添加允许入站的规则 |
