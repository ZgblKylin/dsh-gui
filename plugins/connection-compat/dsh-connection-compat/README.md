# connection-compat

为仍在使用 `connection.requestRejection` 的第三方插件恢复该方法。

## 用途

dsh 0.2.3 从 `@deepseek-ai/dsh-client-connection` 移除了
`connection.requestRejection(request)`，只保留 `admit(request)`；`admit`
的结果在放行时带 `peer`，拒绝时带 `rejection: 401 | 403`。被移除的方法原本只是
对该结果的一行委派：

```ts
requestRejection(request) {
  const admission = this.admit(request)
  return 'rejection' in admission ? admission.rejection : undefined
}
```

已安装的部分第三方插件仍以
`ctx.connection.requestRejection(request) === undefined` 给自己的 HTTP 与
WebSocket 路由做信任围栏。宿主缺少该方法时，这些围栏在请求期抛异常，路由转而
返回 401 / 503，对应功能（右侧栏、皮肤管理、暂停、远程控制路由等）失效。

本插件在宿主不再提供该方法时把同一行委派装回 `connection` 服务：围栏的判定仍
来自宿主自己的准入路径（Host/Origin 检查与会话凭据），语义与 0.2.2 一致。

## 依赖与加载

- inject `connection` 与 `connection.authentication`：`admit` 读取认证提供方，
  未注入该子服务的上下文取不到它。
- 包不声明 `dsh.bundle.patch`，由 wrapper 的显式 mount 行
  `connection-compat` / `dsh-connection-compat` 挂载；两个 profile 都由
  `install.mjs` 写入同一行。
- 宿主仍导出 `requestRejection`、或既无该方法也无 `admit` 时，插件不做任何改动。

## 验证

在 staging 的 web 后端上登录后请求两个依赖该围栏的接口：

```powershell
# 皮肤管理器（旧宿主缺少该方法时返回 503 access-denied）
Invoke-WebRequest 'http://127.0.0.1:<port>/api/dsh/skins' -WebSession $session
# 暂停插件通道（非 POST 返回 404，说明路由已注册）
Invoke-WebRequest 'http://127.0.0.1:<port>/dsh-pause/status' -WebSession $session
```

## 移除条件

- harness 恢复 `connection.requestRejection`，或
- 全部已安装插件改用 `admit`。

届时删除 `plugins/connection-compat/` 目录即可；profile 里的
`connection-compat` 依赖与 insert 行需按 `dsh-plugin-uninstall` 的流程清理。

## 已知限制

- 只补回这一个方法：第三方插件若依赖其它已移除的 API，仍需各自适配。
- 桥接由插件写入服务实例；宿主在运行期重新创建 `connection` 服务时，新的实例需
  要插件重新 apply 才会带该方法（profile 重载会重新 apply）。
