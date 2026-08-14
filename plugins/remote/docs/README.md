# dsh-remote

多后端远程连接插件：在 dsh GUI 的标题栏区域提供连接标签页、汉堡菜单与新建连接页，支持本机端口后端与（VSCode Remote SSH 模式）远端 SSH 部署。非侵入：不修改 dsh 框架本体，仅作为 `plugins/remote/` 插件包挂载到 web profile。

## 特性

- **标题栏标签页**：每个标签页对应一个已接入的 DSH 后端；标签页带关闭按钮。
- **加号新建连接**：点击标签栏右侧 `+` 打开新建连接页；成功后在该标签页中加载对应前端。
- **汉堡菜单**：标题栏 `☰` 内包含所有标签页的切换入口、新建连接、关闭当前连接。
- **全部关闭自动新建**：关闭所有标签页后自动打开一个新标签页。
- **本地连接**：可配置端口（默认 3080 自动填入）。连接时先探测端口是否可加载：可加载则直接加载前端；否则启动内置 dsh（`dsh web --port <端口>`）再加载前端。连接名与端口保存在软件本地存储（localStorage）。
- **远程连接**：可配置地址（不含 `http://` 头）与端口。连接时先探测端口是否可加载：可加载则直接加载；否则尝试 SSH 部署。连接名、地址、端口保存在软件本地存储。
- **SSH 部署（VSCode Remote 风格，安全隧道）**：
  - 与 dsh 地址**分离**的 SSH 主机字段（可用 `~/.ssh/config` 的 Host 别名，如 `ASUS`），复用现有 ssh config。
  - 密码 / 密钥文件二选一（密钥文件通过 `<input type=file>` 选取上传），可勾选"保存认证"。
  - 密码与密钥都留空时，若 ssh config 中存在对应 Host，则直接使用该别名尝试免密连接。
  - 连接过程中出现认证需求（`Permission denied` / publickey / password 等）时判定连接失败，回退到连接配置让用户补齐认证。
  - **远端后端以 `--host 127.0.0.1` 只绑定回环地址**，绝不暴露到 LAN；前端通过 **SSH 本地端口转发**
    （`ssh -N -L 127.0.0.1:<本机端口>:127.0.0.1:<远端服务端口>`）经加密会话访问，网页 only 看到 `http://127.0.0.1:<本机端口>/`。
  - 连接建立后：对端检测 `dsh-gui` 命名的 tmux 会话并且会话内 dsh **存活**；缺失/失效才重新部署与启动
    （检查 `~/.dsh-gui`，缺失则按固定 ref 克隆 deepseek-harness 并编译）。随后**读取会话实际监听的服务端口**，做 SSH 端口转发加载前端。

> **关于"不生成本机监听端口"**：SSH `-L` 本地转发需要一个本机回环监听端点，浏览器才能经 `http://127.0.0.1:<port>/` 访问隧道；该端点只绑定 `127.0.0.1`（不带 `-g`/GatewayPorts），不对外网及局域网开放，即标准的安全隧道形态。若需要"完全不监听本机端口"，则无法再经浏览器 iframe 直达，需换成在 dsh-gui 内部做代理层——当前设计采用前者。

## 配置归属

- **dsh-gui 管理**：连接配置（连接名、地址/端口、SSH 主机/用户名/端口、保存的认证）。
  连接名与地址端口等在浏览器 localStorage（`dsh.remote.*`）；凭证在系统密钥库
  （Windows DPAPI / Linux gpg，路径/文件名含 `ZgblKylin+dsh-gui+<连接名>`），密钥文件存于
  `<DSH_HOME>/gui/keys/`。
- **远端管理**：远端后端自身的 dsh 配置与插件配置，位于远端 `~/.dsh-gui`（DSH_HOME 指向 `~/.dsh-gui/.dsh`），
  与本机完全隔离。

## 结构

```
src/index.ts           Host 半端（Node ESM 包）：/remote-api 路由 + 本地启动/SSH 部署/凭据
src/client/index.ts    浏览器半端：注入 shell.overlay 的标签页 chrome
src/client/RemoteApp.tsx  标签页 / 汉堡菜单 / 新建连接页
src/client/styles.ts/css  自持样式
build.mjs               esbuild 构建：lib/index.js（Host）+ lib/client.js（Browser module）
docs/                  本目录（插件文档）
```

## 构建与安装

```powershell
# 从仓库根目录
npm run install:plugins   # 构建 + 安装 + 挂载 plugins/ 下所有插件
# 或单独：
node .toolchain/node_modules/pnpm/bin/pnpm.cjs install --store-dir .pnpm-store
node build.mjs
```

挂载到 web profile（由 `npm run install:plugins` 自动完成，等价于）：

```text
注入 .dsh/profiles/web/package.json      "dsh-remote": "link:./plugins/remote"
注入 .dsh/profiles/web/cordis.patch.yml  - id: remote / name: dsh-remote
```

装好后 **重启 dsh-gui** 生效。生效后浏览器端挂在 `shell.overlay`（`id: remote.chrome`），
仅在最顶层页面渲染（避免在连接 iframe 内递归渲染）。

## 运维

- 本地后端日志：`<DSH_HOME>/gui/remote-<端口>.log`
- 关闭本地连接标签页或插件卸载时，对应后端进程树一并终止；卸载时所有 SSH 隧道一并关闭。
- 密码方式 SSH 需要本机有 `plink` 或 `sshpass`；否则请使用密钥文件或依赖 ssh config。
- 远端部署默认克隆 `deepseek-harness` 上游 `main`；可用环境变量 `DSH_REMOTE_REPO_URL` / `DSH_REMOTE_REPO_REF` 固定仓库与 ref 以复现部署。远端 dsh 配置与插件配置位于 `~/.dsh-gui/.dsh`，与本机完全隔离。
- 安全边界：`/remote-api` 为未认证的本机 RPC，插件会拒绝在非回环绑定（`webServer.host !== 127.0.0.1`）下启动。
- Linux gpg 凭据使用内置口令（`dsh-remote-app-pin`）作**混淆级**保护，明文与密钥强度取决于部署环境；如需更强保护请改用系统钥匙环或加密文件系统。

## 评审与改进

代码评审结论见 [review.md](review.md)，按严重程度列出待改进项（就绪误判、WinDPAPI 凭据往返、
信任边界、远端部署固定版本等）。后续改进请同步更新该清单。

## 测试

SSH 远程模式可用 `~/.ssh/config` 中已有的别名测试，例如：

- 新建连接 → 远程连接 → 地址填目标机地址，SSH 主机填 `ASUS`，用户名留空（ssh config 提供 User）
- 密码/密钥留空：若 `~/.ssh/config` 的 `ASUS` 可免密登录（`PreferredAuthentications publickey` + IdentityFile），
  则直接复用该配置连接；若需要认证则回退到连接配置，提示填写用户名/密码/密钥。
