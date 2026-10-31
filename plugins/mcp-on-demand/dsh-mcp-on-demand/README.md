# dsh-mcp-on-demand

按技能触发 MCP 连接：**MCP 服务器平时保持关闭，只有加载了绑定技能的瞬间才连上**，用完之后本次会话继续保留（可在面板里手动关掉）。

当前默认绑定：**`reverse-engineer-anything`（REA）技能 → `rea` MCP 服务器**。

```
模型调用 skill(reverse-engineer-anything)
      │
      ▼
dsh-mcp-on-demand 监听到这次 skill 调用
      │  ctx.loader.update(rea 条目, { disabled: false })
      ▼
@deepseek-ai/dsh-mcp-client 热连接 REA MCP，注册 mcp__rea__* 工具
      │
      ▼
skill 结果尾部追加一行提示；下一步的模型请求里就能看到 REA 工具
```

## 为什么要它

REA MCP 有 200+ 个工具，常驻会让每次请求都带上整份工具 schema。把它在 patch 里设成 `disabled: true`，没有 REA 任务时上下文里一个 REA 工具都没有；需要时由一次 skill 加载把它热启起来，不用重启 harness。

## 配置

```yaml
- insert:
    - id: mcp-on-demand
      name: 'dsh-mcp-on-demand'
      config:
        bindings:
          - skill: reverse-engineer-anything   # 触发用技能名
            server: rea                        # mcp-client 条目的 config.serverName
            timeoutMs: 180000                  # 等工具注册的上限（REA 启动慢，留足）
        # 可选：由本插件自己创建、默认禁用的 mcp-client 条目
        servers:
          some-server:
            transport: stdio
            command: 'C:/Program Files/nodejs/node.exe'
            args: ['C:/path/to/server.mjs']
            env: {}
```

- `bindings[].server` 匹配已有 loader 条目（profile `cordis.patch.yml` 里 `@deepseek-ai/dsh-mcp-client` 行的 `serverName`）；找不到时按 `servers` 里的同名内联条目处理，都没有则在 skill 结果里报告失败。
- 已有条目在 patch 里保持 `disabled: true` 才会跨重启一直关闭；本插件只在本次运行里热启用它（Loader 的根树 `write()` 是空实现，运行时开关不落盘）。
- `servers` 里声明的条目由插件在启动时以 `disabled: true` 创建，插件卸载/重启时一并删除。

## 触发方式

1. 模型调用 `skill` 工具加载绑定技能（主路径）；
2. 用户直接发 `/<skill-name>`（在消息进入 inbox 时就开始连接）。

两者都会把对应的 MCP 服务器启用并等待其工具注册完成。成功后 skill 结果末尾会出现：

```
[mcp-on-demand] MCP server "rea" is connected; its tools (mcp__rea__*) are available from the next step. ...
```

失败（条目缺失、连接失败、超时）时同样追加一条说明，模型可据此走技能自带的 recovery 指引。

## 安装

本仓库内由 `plugins/mcp-on-demand/install.mjs` 走共享安装流水线：

```powershell
npm run install:plugins                     # web profile（默认）
# desktop build 链会以 DSH_PLUGIN_PROFILE=desktop 自动再跑一遍
```

单独安装到当前 profile 也可以用运行时自带的插件管理器（按绝对目录安装本包）。

## 已知限制

- 工具在**下一步**的模型请求里出现（本步的 tool list 在 skill 调用前已经组装好）。
- 启用后本次会话保持连接，不会自动卸载；要释放上下文请在「设置 → Skill & MCP」或侧边栏 MCP 面板里手动停用（运行时开关，重启后回到 patch 的 `disabled: true`）。
- 只监听 `skill` 工具与 `/<skill>` 消息；其它方式加载技能（例如子会话里直接注入）不会触发。
- 包内无 `@deepseek-ai/*` 依赖、无 Schemastery schema，配置由插件自行校验；错误以 `mcp-on-demand:` 前缀记录到宿主日志。
