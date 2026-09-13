# Electron desktop 架构分析（dsh-v0.1.5-rc.2）：与 dsh-gui Tauri 封装的对比

## 结论摘要

`deepseek-harness/apps/desktop` 是一个 Electron 外壳，但它不属于只做「套壳、启动后端、加载 Web UI」的薄封装。判断为**部分**：对 harness 的产品面它是薄封装，外壳不实现会话、设置、凭据、工具或插件系统，Web UI 与后端都来自被安装进 profile 的 `@deepseek-ai/dsh` 包；对 dsh 运行时的交付与更新它不是薄封装，自研面包括 seed 离线安装与完整性校验、事务化激活与回滚、独占 profile、自带 Node.js 与 pnpm，以及应用二进制更新通道与一整条发布流水线。

全部证据在 `deepseek-harness/` 子模块内（只读）。引用 `.md` 行号时表示上游文档的陈述，引用 `.ts`/`.yml`/`.mjs`/`.json` 行号时表示源码事实；两类不一致处会显式指出。文件规模按物理行数统计。

下文用 `README.md` 指 `deepseek-harness/apps/desktop/README.md`，用 `note` 指 `deepseek-harness/.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md`。相对路径 `apps/`、`packages/`、`vendor/` 与 `src-tauri/` 分别相对 `deepseek-harness/` 与本仓库根目录。

## 1. 进程模型与通道

### 1.1 进程与窗口

Electron main 进程的职责是桌面项目所有权、自定义协议、窗口与生命周期，见 `deepseek-harness/apps/desktop/src/main.ts:1`。主窗口用 `createWindow` 创建，`webPreferences` 为 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`（`main.ts:89-95`），并拒绝 `window.open` 与跳出 `dsh-app:` 的导航（`main.ts:97-100`）。

窗口有两个，各自加载不同宿主名的 `dsh-app://` 资源。主窗口用 `preload-app.cjs` 预加载脚本（`main.ts:148`）加载 `dsh-app://app/index.html`（`main.ts:363`），该预加载只暴露 `{ protocolVersion: 1 }` 标记（`src/preload-app.ts:5`）。插件窗口用 `preload.cjs`（`main.ts:149`）加载 `dsh-app://shell/plugin-manager.html`（`main.ts:325`），通过 `preload.ts` 暴露 locale、插件增删改查与更新订阅（`src/preload.ts:6-24`）。IPC 处理函数用 `assertDesktopSender` 校验发送方帧必须来自 `dsh-app:` 且宿主名为 `shell`（`main.ts:104-111`，调用点 `main.ts:234,242,246,265,269`）。

dsh 后端不跑在 Electron 进程内。`DesktopHostProcess` 用自带的 Node.js 可执行文件启动 `spawn`，参数为目标 profile 下 `node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` 与 profile 目录，`stdio` 为 `['ignore','pipe','pipe','pipe','pipe','ipc']`（`src/host-process.ts:101-113`）。父进程从 `stdin` 的位置 3 与 4 取得请求管道与响应管道（`host-process.ts:114-119`）。Host 进程入口在 `apps/desktop-host/src/index.ts:376-578` 的 `main()`，它用同一组 fd 打开管道（`index.ts:385-386`），经 `runDesktopHost` 组合并启动完整 Cordis 树（`index.ts:289-296`）后通过 `process.send` 上报 `ready`（`index.ts:407-411`）。

### 1.2 三类通道的分工

协议版本为 `3`，请求管道 fd 为 3、响应管道 fd 为 4、保留给 Node 生命周期 IPC 的 fd 为 5，单个数据帧的原始字节上限为 64 KiB（`src/host-protocol.ts:4,7-13,16`；Host 侧同样的 fd 与上限见 `apps/desktop-host/src/wire.ts:4,7-13`，其中不重复声明 fd 5）。帧头固定 13 字节，包含 magic `0x44534833`、类型、单调流 id 与载荷长度（`host-protocol.ts:18-19,92-105`）。

Node IPC 只承载生命周期控制，不承载 Fetch 载荷：命令仅有 `shutdown`，事件仅有 `ready` 与 `fatal`（`host-protocol.ts:42-55`）。外壳用 `child.on('message')` 接收并校验事件（`host-process.ts:137-144`），用 `child.send` 发送 `shutdown`（`host-process.ts:273-277`）；Host 侧同样只接受 `{ type: 'shutdown' }`（`index.ts:84-87`）。

分帧字节管道承载 Fetch 与流式响应。每个请求分配一个单调流 id，先发 `start`（含 url、method、headers、hasBody），再按 64 KiB 切分发送 `data`，最后发 `end`（`host-process.ts:222-261`）。响应侧有 `start`、`data`、`end`、`error` 四类帧（`host-protocol.ts:57-75`），由 `DesktopHostResponseDecoder` 增量解码并校验帧标记与载荷上限（`host-protocol.ts:132-183`）。写入侧串行化并在管道未 drain 时等待（`host-process.ts:263-271`；Host 侧对应 `index.ts:387-395`）。

背压与取消是双向的。响应流下游消费不足时暂停整个响应管道，消费恢复后继续（`host-process.ts:323-326,384-386`）；请求体发送侧同理暂停请求管道（`index.ts:513-516,421-423`）。取消通过 `cancel` 帧表达（`host-protocol.ts:127-129`），外壳在 `AbortSignal` 触发时取消请求体读取、发 `cancel` 帧并结算挂起响应（`host-process.ts:175-192`）。

`dsh-app://` 承载 Web 资源。该方案注册为 privileged，带 `standard`、`secure`、`supportFetchAPI`、`stream`、`codeCache` 与关闭 CORS 的权限（`main.ts:30-40`）。`protocol.handle` 按宿主名分派：`shell` 由外壳从应用内 `renderer` 目录读文件并做路径穿越防护（`main.ts:226,113-131`）；`app` 转发给当前 Host 进程的 `fetch`，无 Host 时返回 503（`main.ts:227-231`）；其他宿主名返回 404。Host 侧把三类路径分派到不同处理器：`/.dsh/remote-stream` 走 Typert 远程流的 NDJSON 桥（`index.ts:339-340,223-265`），`/api/` 走 `connection.createSharedFetchHandler('/api')`（`index.ts:341-342,305`），其余走从 `@deepseek-ai/dsh-web-frontend/dist` 读取的静态资源处理器，其中 `/plugins/` 前缀交给 `clientModules.fetchBundle`（`index.ts:343,185-221,200`）。

主窗口页面在 index.html 中被注入 `globalThis.__DSH_TRANSPORT__`，该脚本把 Remote stream 映射为对 `/.dsh/remote-stream` 的 POST 并逐行解析 NDJSON（`index.ts:99-120,190-192`）。这与浏览器组合的传输脚本不同：桌面组合由外壳拥有的载体提供等价能力，源码注释把它记作「carrier-neutral RPC and Fetch registries without requiring `webServer`」（note:17）。

### 1.3 不开监听端口

README 把这一点当作已决决策陈述：应用「opens no listening port」，`dsh-app://` 承载 Web 资源与 Fetch，字节管道承载有界请求与响应分块，Node IPC 只承载子进程生命周期控制（`README.md:5,16`）。Agent Note 给出同样的表述与原因：监听式 Web 服务会引入端口所有权、认证、CORS 与暴露面（`README.md:16`；note:17）。

代码侧可验证的是：对 `apps/desktop/src` 与 `apps/desktop-host/src` 检索 `listen(`、`createServer`、`node:http`、`node:net` 与 `WebSocket` 均无匹配；组合层禁用了 `web-startup`、`webserver`、`web-runtime` 三行（`apps/desktop-host/config/desktop.cordis.patch.yml:3-10`）；每次请求都由 `protocol.handle` 在本进程内转发，而不是发给一个回环地址（`main.ts:224-231`）。

## 2. Cordis 组合方式

桌面层复用浏览器组合，并在其上叠加自己的 patch。层序为：profile 各 bundle 的 patch、profile 自身 patch、最后是 Host 包自带的 `desktop.cordis.patch.yml`（`apps/desktop-host/src/index.ts:160-164`）。profile 的 bundle 列表固定以 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 开头，插件依次追加在其后（`apps/desktop/src/project-manager.ts:105,274-285`）。用于启动的根配置由 Host 在运行时写入，内容为空数组（`index.ts:95-96,285-286`）。

`desktop.cordis.patch.yml` 的注释说明其目的：「Electron reuses the browser composition without its network and browser-launch rows」（`desktop.cordis.patch.yml:1`）。它禁用 7 行，并在 `web-app` bundle 中逐一对得上：

| 桌面层禁用行 | 桌面层行号 | web-app 层对应行与插件名 |
| --- | --- | --- |
| `web-startup` | `apps/desktop-host/config/desktop.cordis.patch.yml:3-4` | `packages/bundle/web-app/cordis.patch.yml:127-128`（`@deepseek-ai/dsh-web-app/startup`） |
| `webserver` | `apps/desktop-host/config/desktop.cordis.patch.yml:6-7` | `packages/bundle/web-app/cordis.patch.yml:135-136`（`@deepseek-ai/dsh-host-webserver`） |
| `web-runtime` | `apps/desktop-host/config/desktop.cordis.patch.yml:9-10` | `packages/bundle/web-app/cordis.patch.yml:154-155`（`@deepseek-ai/dsh-web-app`） |
| `client-hmr` | `apps/desktop-host/config/desktop.cordis.patch.yml:12-13` | `packages/bundle/web-app/cordis.patch.yml:167-168`（`@deepseek-ai/dsh-client-hmr`） |
| `open-in-app` | `apps/desktop-host/config/desktop.cordis.patch.yml:15-16` | `packages/bundle/web-app/cordis.patch.yml:65-66`（`@deepseek-ai/dsh-host-open-in-app`） |
| `ui-open-in-app` | `apps/desktop-host/config/desktop.cordis.patch.yml:18-19` | `packages/bundle/web-app/cordis.patch.yml:72-73`（`@deepseek-ai/dsh-client-ui-open-in-app`） |
| `directory-picker` | `apps/desktop-host/config/desktop.cordis.patch.yml:21-22` | `packages/bundle/web-app/cordis.patch.yml:97-98`（`@deepseek-ai/dsh-host-directory-picker-auto`） |

README 的另一处陈述与此吻合：「Open In...」动作因宿主插件需要 HTTP 路由而在桌面被禁用（`README.md:177`），对应代码即上表中两行被禁用。

桌面层改写了 `connection` 行：`inject` 变为 `credentials`，`config` 置空（`desktop.cordis.patch.yml:24-27`）。web-app 层同一行注入 `webRuntime`，并从 `ctx.webRuntime.trustedHosts` 取 LAN 字面量（`web-app/cordis.patch.yml:181-188`）。Loader 对条目差异的处理把 `name`、`inject`、`group` 归为替换项（`deepseek-harness/vendor/loader/src/config/entry.ts:194`），因此改写后的 `connection` 不再依赖已被禁用的 `web-runtime` 行所需的服务。

桌面层还插入了两行 `directory-picker-native`（`desktop.cordis.patch.yml:29-34`），对应包存在于 `packages/host/directory-picker-native` 与 `packages/client/ui-directory-picker-native`，并作为运行时依赖出现在 `apps/desktop-host/package.json:21,23`。

Host 在组合完成后额外做两件事。一是把 `agent-presets` 行的 roots 指向 dsh 包内的 `config/agent-presets`，信任级为 `system`（`index.ts:166-175`）。二是强制校验 bundle 层解析位置：非开发模式下，任何 bundle 的 `packageDir` 必须落在桌面 profile 内，否则拒绝启动（`index.ts:152-159`）。组合必须提供 `connection`、`typertGateway`、`clientModules` 三者，否则释放 fiber 并报错（`index.ts:301-304`）。

## 3. 状态与所有权

桌面自有状态全部位于 `$DSH_HOME/desktop`，活动 profile 固定为 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts:30-46`）。同目录下还有 `staging/`、`rollback/profile/`、`pending.json` 与 `lock`（`paths.ts:35-38`），pnpm 的 store、cache、state、config、home 五个子目录（`paths.ts:39-46`）。

profile 是一个普通 npm 项目：清单名称固定为 `@deepseek-ai/dsh-desktop-runtime`，`private` 必须为 `true`（`project-manager.ts:102,253-262`）；依赖表把每个核心包指向 `desktop-packages/` 下的本地 `file:` tarball，精确版本与 integrity 记录在 `desktop-packages.json`（`core-package-set.ts:108-123,131-159`；一致性要求见 `project-manager.ts:264-270`）；事务复制与校验的元数据文件为 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`desktop-release.json`、`desktop-packages.json` 与 `desktop-packages/` 目录（`project-manager.ts:39-45`；`core-package-set.ts:8-11`）。`dsh.profile.bundles` 记录内置 bundle 与已安装插件的顺序（`project-manager.ts:291-303`）。

进程生命周期锁先于任何 profile 访问。`claimDesktopSingleInstance` 在模块顶层、`app.whenReady()` 之前调用（`main.ts:386-388`）。它调用 `requestSingleInstanceLock()`：未获得锁的进程调用 `quit()` 并返回 `false`，因此不进入启动流程；持有者注册 `second-instance` 监听器，后续启动会触发它聚焦或重建主窗口（`single-instance.ts:16-25`；`main.ts:350-360`）。Agent Note 明确把该锁称为「the authoritative Desktop owner」（note:72）。

事务锁是第二层防护。锁文件以 `openSync(path, 'wx')` 独占创建，写入持有者 PID；发现已存在时读取 PID，用 `process.kill(pid, 0)` 判断持有者是否存活，只有确认进程已消失才删除锁文件并重新获取（`project-manager.ts:645-682`）。pnpm 子进程启动后，持有者 PID 改为该子进程；子进程退出后再改回 Electron（`project-manager.ts:595-600,613-618`）。README 把这一机制记为深度防御，并说明其目的：后续进程不能把仍在运行的孤儿 worker 当作陈旧事务（`README.md:52`）。

CLI 与 Desktop 的边界由 CLI 侧拒绝而非文档约定保证：`apps/cli/src/args.ts:69-70` 在 profile 名大小写不敏感地等于 `desktop` 时报错，错误信息为 `error: profile "desktop" is managed exclusively by the Electron application`。可共享的数据是 `$DSH_HOME` 下的会话、设置、凭据、工作区与 storage；可执行包、插件激活、lockfile 与包管理器状态不共享（`README.md:180`；`README.md:15`）。

## 4. 安装、激活与回滚

README 把启动安装描述为一条串行事务，共 6 步：恢复中断的激活日志、校验 seed 清单与本地包集合并要求 seed 版本等于 Electron 应用版本；活动 profile 已含同一版本时直接复用；否则校验归档条目、解压 store 分片、合并包文件与 SQLite 索引、建 staging profile 并执行离线安装；Electron 升级时从旧活动 profile 读取每个插件的精确版本并离线补装；停止活动后端、健康检查后再启动活动后端；持久化每个激活阶段后执行目录搬移，并提供回滚 profile（`README.md:41-48`）。

代码与上述步骤一一对应。`applyRelease` 先 `recover()`、`verifySeedIntegrity(seedDir)`、校验 seed 内的本地包集合，再要求 `target.version === electronVersion`，任一不符即抛错（`project-manager.ts:394-402`）。复用条件同时检查 `desktop-release.json` 的版本、profile 内实际安装的 dsh 版本与 Desktop Host 版本三者与目标版本相等（`project-manager.ts:403-408`），随后才读取已安装插件清单、复制元数据、执行 `pnpm install --offline --frozen-lockfile --trust-lockfile`，并在有插件时以 `--save-exact --offline` 逐个补装（`project-manager.ts:412-428`）。

健康检查把 staging 与活动后端互斥起来。`main.ts` 提供的 hooks 在检查时先停掉活动 Host，再单独启动并停止 staged Host，然后重启活动 Host；两者都失败时抛 `AggregateError`（`main.ts:164-194`）。激活阶段先写 `pending.json` 的 `prepared`，再调用 `beforeActivate` 停后端，把活动 profile 移入 `rollback/profile`，再把 staging 移到活动位置；失败时删除残留并把 rollback 移回（`project-manager.ts:519-549`）。恢复函数在 `pending.json` 存在且活动 profile 缺失、rollback 存在时执行反向搬移，并清理 staging（`project-manager.ts:342-363`）。

seed 的完整性校验遍历 seed 目录全部文件，拒绝符号链接与非普通文件，计算 SHA-256 后与 `integrity.json` 记录逐项比对（`project-manager.ts:206-251`）。核心包集合另有一条更强的校验：`desktop-packages/` 目录的文件名集合必须与 `desktop-packages.json` 完全一致，每个 `.tgz` 的字节数与 `sha512` 摘要必须匹配（`core-package-set.ts:131-159`）；lockfile 中任何被本地化的核心包名如果以 registry 版本出现即报错（`core-package-set.ts:170-183`）。

pnpm store 以确定性分片传输。打包时按「路径 SHA-256 取模分片数」把 store 文件分到最多 256 个分片（默认 16），写成不压缩的 tar 并记录条目数（`seed-store.ts:62-64,174-207`）。启动时先校验归档集合与清单一致、条目路径安全、条目归属分片正确、条目总数正确，再解压到临时目录（`seed-store.ts:214-258`），随后把非索引文件复制进持久 store，并把各 store 版本的 SQLite `package_index` 记录以事务 `INSERT OR REPLACE` 合并（`seed-store.ts:151-166,120-144`）。

pnpm 调用的隔离面是显式的：只使用自带 Node.js 执行自带 pnpm 入口，注入 `--config.registry`、`--config.store-dir`、`--config.userconfig` 与 `--config.enable-global-virtual-store=false`，并把 `XDG_*`、`PNPM_HOME`、`COREPACK_HOME`、`NPM_CONFIG_*` 全部指向桌面目录（`project-manager.ts:551-586`）；继承的环境变量里剔除 `DSH_DESKTOP_*`、`npm*`、`pnpm*`、`corepack*`（`project-manager.ts:560-562`）。`allowBuilds` 策略只在 `pnpm-workspace.yaml` 里显式列出允许与禁止生命周期的包（`project-manager.ts:124-134`）。

插件写入只接受 registry 包规格。`packageNameFromSpec` 拒绝空串、前导 `-`、空白与反斜杠、含 `://` 以及 `file:` 开头的规格（`project-manager.ts:162-180`）；安装后必须能在 profile 内找到清单，且该清单必须声明 `dsh.bundle.patch` 且 patch 路径落在包目录内（`project-manager.ts:305-326`）。增删改三种变更都经 staging、健康检查、激活同一条路径（`project-manager.ts:440-456`；`README.md:50`）。

## 5. 升级模型与版本同一性

版本同一性是发布契约。Electron 包、`@deepseek-ai/dsh` 包与桌面 Host 包在 `dsh-v0.1.5-rc.2` 中同为 `0.1.5-rc.2`（`apps/desktop/package.json:4`；`apps/cli/package.json:2,4`；`apps/desktop-host/package.json:4`），仓库根清单 `@deepseek-ai/dsh-root` 也取同一版本（`deepseek-harness/package.json:2-3`）。代码在三个位置强制这一点：seed 版本必须等于 Electron 版本（`project-manager.ts:400-402`）；打包时 `desktopVersion` 必须等于 `dshVersion`（`scripts/package-target.ts:102-106`，该处的 `dshVersion` 取自仓库根清单）；生成 seed 时若 Electron 版本与 `@deepseek-ai/dsh` 实际版本不同即报错（`scripts/prepare-seed.ts:55`）。`desktop-release.json` 另外携带 `hostProtocolVersion`，解析时必须等于协议版本 3（`src/release.ts:11,21-27`）。

README 用「Release identity」一行陈述该决策与直接后果：Electron 与 `@deepseek-ai/dsh` 始终同版本，dsh 升级本身就是一次 Desktop 发布（`README.md:11`）。Agent Note 的表述是：一次发布编号同时标识 Electron 产物与其精确的 dsh 与 Host 依赖，因此更新 dsh 需要新的 Electron 发布，即使外壳代码未变（note:21）。

更新通道由 `electron-updater` 承担。协调器在构造时关闭自动下载与退出时自动安装，默认启用条件是应用已打包且 `process.resourcesPath/app-update.yml` 存在（`src/update-coordinator.ts:26-32`）。`check()` 与 `install()` 各自合并并发调用：安装会先等待在途检查，而不是复用检查结果（`update-coordinator.ts:35-50`）。安装流程为下载更新、发布 `ready` 状态、调用 `beforeRestart` 停掉 dsh 子进程，再 `quitAndInstall(false, true)`（`update-coordinator.ts:74-93`）。`main.ts` 把 `beforeRestart` 实现为「标记退出由安装器接管并停止 Host」（`main.ts:214-222`），并在主窗口加载完成后 10 秒触发一次检查（`main.ts:368`），菜单项触发同一个检查（`main.ts:337`）。

发布侧由 electron-builder 生成 generic provider 的更新元数据（`apps/desktop/electron-builder.config.mjs:105`）；macOS 目标为 `dmg` 与 `zip`，Windows 为 `nsis`，NSIS 打开差分包（`electron-builder.config.mjs:70,94,100-104`）。README 说明更新行为：主窗口打开 10 秒后检查目标平台的发布流，可用版本弹一次原生确认框，接受后等待在途检查、下载并校验已签名的发布包、停止 dsh 子进程，把安装与重启交给 electron-updater，下次启动先按版本核对 seed（`README.md:167`）。这一描述与 `update-coordinator.ts` 的实现一致。

升级后的插件保留是自研的。旧活动 profile 存在时，安装流程逐个读取插件的「名称 + 精确版本」，用同一次离线 pnpm 调用补装到 staging，再重写 bundle 列表（`project-manager.ts:412-424`）。README 把首次安装记为「没有插件恢复步骤」（`README.md:46`）。

桌面打包功能随 `0.1.5` 系列首个 tag 进入发布。以引入该功能的 commit `19444907f0` 为查询对象，`git -C deepseek-harness tag --contains 19444907f0` 输出 `dsh-v0.1.5-alpha.1`、`dsh-v0.1.5-alpha.2`、`dsh-v0.1.5-rc.1`、`dsh-v0.1.5-rc.2`，即该 commit 自 `dsh-v0.1.5-alpha.1` 起包含在发布 tag 中；本次分析所在的 `dsh-v0.1.5-rc.2` 属于该序列。

## 6. 与 dsh-gui（Tauri）的对比

### 6.1 自研代码规模

| 位置 | 文件数 | 物理行数 |
| --- | --- | --- |
| Electron 外壳运行时 `apps/desktop/src/*.ts` | 14 | 2576 |
| 桌面 Host 包 `apps/desktop-host/src/*.ts` | 2 | 771 |
| 桌面插件管理渲染层 `apps/desktop/renderer/*` | 3 | 244 |
| 打包与发布脚本 `apps/desktop/scripts/*`（21 个模块，另含 `windows-sign.cmd` 17 行未计入）加 `electron-builder.config.mjs`、`tsdown.config.ts` | 23 | 3100 |
| 桌面单元测试 `apps/desktop/tests/*.spec.ts` | 17 | 2381 |
| Tauri Rust `src-tauri/src/*.rs` | 8 | 5503 |
| Tauri 外壳页 `src-tauri/ui/*` | 4 | 4851 |
| Tauri 内联测试 `src-tauri/src/main.rs` 内的 `mod tests` | 1 | 118 |
| Tauri 生成的自更新脚本 `src-tauri/src/update_script.mjs` | 1 | 305 |

两点规模事实值得单独指出。其一，Electron 侧的运行时自研代码（外壳 2576 行加 Host 771 行加渲染层 244 行，共 3591 行）小于 Tauri 侧（Rust 5503 行加外壳页 4851 行，共 10354 行）。其二，Electron 侧多出一条 Tauri 侧不存在的发布面：约 3100 行打包脚本与 2381 行单元测试，Tauri 侧没有对应的发布流水线，原因是本仓库不产出安装包（`src-tauri/tauri.conf.json:17` 的 `bundle.active` 为 `false`）。因此「薄」不能由行数判断，它体现在各自承担的责任上。

### 6.2 职责差集

`src-tauri/src/main.rs:1-18` 自述 Tauri 外壳只做三件事：从仓库内子模块检出启动 `dsh web`、等待回环端口应答、打开一个无边框窗口，其中每个连接 tab 由独立子 webview 承载。对照 note:29-35 的职责表，Tauri 侧只覆盖「Electron shell」一行里窗口与子进程生命周期相关的部分，加上它自己的仓库更新入口；它没有对应「Bundled Node.js and pnpm」、「Desktop profile」与「Private Desktop Host package」三行。

| 能力 | Electron desktop（dsh-v0.1.5-rc.2） | dsh-gui（Tauri） |
| --- | --- | --- |
| 后端启动 | 自带 Node 执行 profile 内 `dsh-desktop-host` 入口（`apps/desktop/src/host-process.ts:101-113`） | 系统 `node` 执行仓库内 `deepseek-harness/apps/cli/lib/bin.js web --port <port> --no-open`（`src-tauri/src/main.rs:460-471`） |
| 运行时与包管理器 | 自带 Node.js 24.17.0 与包内 pnpm（`apps/desktop/scripts/prepare-runtime.ts:14,82-92`；解析处 `apps/desktop/src/main.ts:55-63`） | 依赖系统 `node`，入口缺失即报错并提示先运行 `npm run setup`（`src-tauri/src/main.rs:439-444`） |
| Web UI 来源 | 安装进 profile 的 dsh 包内 `@deepseek-ai/dsh-web-frontend`（`apps/desktop-host/src/index.ts:186-193`） | 仓库 checkout 构建出的 harness（`src-tauri/src/main.rs:187-189`） |
| 前端承载 | `dsh-app://` 加分帧字节管道，主窗口与插件窗口各一（`apps/desktop/src/main.ts:224-231,363,325`） | 回环 HTTP，加每个连接 tab 一个子 webview（`src-tauri/src/main.rs:1452-1456`；`src-tauri/src/views.rs:156-197`） |
| profile 所有权 | 独占 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts:34`），CLI 拒绝同名 profile（`apps/cli/src/args.ts:69-70`） | 以 `<repo>/.dsh` 为共享 home 启动 CLI 的 `web` 应用（`src-tauri/src/main.rs:449,462-468`），profile 由 CLI 决定，无独立 desktop profile |
| 离线安装与回滚 | seed 校验、staging、健康检查、日志化目录搬移与 rollback profile（`apps/desktop/src/project-manager.ts:394-436,519-549`） | 无；依赖仓库内已构建的 harness |
| 插件安装 | 外壳自带插件管理窗口，只走自带 pnpm（`apps/desktop/src/main.ts:250-263,315-326`；`apps/desktop/renderer/plugin-manager.js:29-60`） | 无独立窗口，插件由 `dsh plugin` 与仓库脚本管理 |
| 应用更新 | `electron-updater` 加 generic provider（`apps/desktop/src/update-coordinator.ts:6,26-32`；`electron-builder.config.mjs:105`） | 仓库 fast-forward 加重新构建加重启（`src-tauri/src/update_script.mjs:1-6`），`src-tauri/Cargo.toml:15-21` 无 updater 插件，`src-tauri/tauri.conf.json:17` 不产出安装包 |
| 多连接 | 无对应实现，只有主窗口与插件窗口 | 连接 tab 子 webview、WebView2 权限同意与对话框卡片（`src-tauri/src/views.rs:51-135,156-197`；`src-tauri/src/dialogs.rs:128`） |
| 进程退出清理 | 关闭请求管道写端释放 Windows 挂起读，再等 10s、SIGTERM、SIGKILL（`apps/desktop/src/host-process.ts:200-220`） | Windows job object 加关闭即杀，失败回退 `taskkill /T /F`（`src-tauri/src/main.rs:62-184,761-785`） |

两侧的共同点是「外壳不实现 harness 的产品能力」。Tauri 侧没有会话、设置、凭据或工具的实现，全部由被启动的 harness 提供；Electron 侧同样如此，桌面 Host 只是把已安装项目的 Cordis 组合起来并转发请求。差异集中在外壳是否负责把 dsh 装到用户机器上、并保证可启动、可回滚、可更新。

## 7. 「薄封装」判断

判断为**部分**，理由分三层。

对 harness 的产品面，Electron 桌面是薄封装。外壳不实现任何产品能力，Web UI、后端与插件系统都来自 profile 内安装的 `@deepseek-ai/dsh`（`apps/desktop-host/src/index.ts:186-193,289-296`；note:33 的职责表把「Installed dsh package」列为后端、匹配的 Web UI、启动清单与客户端 bundle 的提供者）。外壳窗口只加载被安装的前端 dist 与 client bundle。

对运行时的交付面，它不是薄封装。四个自研面在 Tauri 侧没有对应物：seed 的离线安装与完整性校验（`project-manager.ts:206-251,394-436`；`seed-store.ts:174-258`）；事务化激活、日志化恢复与单一回滚 profile（`project-manager.ts:342-363,519-549`）；profile 独占与两级锁（`paths.ts:34`；`single-instance.ts:20-23`；`project-manager.ts:645-682`）；自带 Node.js 与 pnpm（`scripts/prepare-runtime.ts:14,82-92`；`project-manager.ts:551-586`）。这四项合起来回答的问题是「在用户机器上如何得到一份可启动、可回滚的 dsh」，而不是「如何显示 dsh」。

第三层是发布与更新。`electron-updater` 加 generic provider 加签名产物（`update-coordinator.ts:6,26-32`；`electron-builder.config.mjs:64-105`）与约 3100 行打包脚本构成 Tauri 侧没有的发布面。反过来，Tauri 侧在外壳功能上更重：连接 tab 子 webview、WebView2 权限同意、对话框卡片窗口与自更新脚本，这些在 Electron 侧没有对应实现。

因此更准确的表述是：Electron desktop 相对 harness 是薄封装，相对「把 dsh 交付到桌面」不是薄封装。它与 dsh-gui 的 Tauri 封装同类的地方在于都由外壳承载 Web UI，不同类的地方在于它还承担了包安装、运行时捆绑与二进制更新。

## 与任务描述的出入

任务描述把 seed 安装归到 `seed-store.ts`。实际的事务所有者是 `project-manager.ts`（725 行），它负责 seed 校验、staging、健康检查钩子、激活与回滚、事务锁以及 pnpm 调用；`seed-store.ts`（271 行）只负责确定性分片归档、解压校验与 pnpm store 的 SQLite 索引合并。任务描述未列出 `project-manager.ts`，而它是桌面运行时自研代码中最大的单文件。

## 不确定项

1. 发布流水线未实际运行。`pnpm run package:desktop*`、`prepare:seed` 与签名、公证流程依赖生产发布环境，本文关于打包行为的结论全部来自脚本源码阅读，没有本机执行结果。
2. `connection` 行的 `inject` 差异按 Loader 的替换语义解释（`vendor/loader/src/config/entry.ts:194`）；`config: {}` 与 web-app 层 config 之间是替换还是合并，我没有逐行验证 `_patchContext` 的实现，只能确认 `inject` 被替换。
3. macOS 种子签名、Mach-O 重写与分片的实际行为未在本机复现（当前为 Windows 环境），相关结论来自 `scripts/macos-seed-store.ts` 与 README 的阅读。
4. 没有运行任何 Electron 应用。进程模型与 fd 3、4、5 在 Windows 下的实际可用性来自代码阅读，未做运行时验证。
5. `$DSH_HOME/profiles/desktop` 的 CLI 拒绝逻辑只核对了参数解析层（`apps/cli/src/args.ts:69-70`），未逐一验证 boot、config-dump 与插件管理三条子命令的调用路径都经过该检查。

## 相关文件

- `deepseek-harness/apps/desktop/README.md` —— 决策表、安装所有权、seed 安装、打包与更新
- `deepseek-harness/.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md` —— 设计权威
- `deepseek-harness/apps/desktop/src/` —— 外壳实现（`main.ts`、`host-process.ts`、`host-protocol.ts`、`project-manager.ts`、`seed-store.ts`、`update-coordinator.ts`、`paths.ts`、`single-instance.ts`、`core-package-set.ts`、`release.ts`、`locale.ts`、`ipc.ts`、`preload.ts`、`preload-app.ts`）
- `deepseek-harness/apps/desktop-host/src/` 与 `config/desktop.cordis.patch.yml` —— Host 入口、线协议与组合 overlay
- `deepseek-harness/apps/desktop/scripts/`、`electron-builder.config.mjs` —— 打包与发布
- `src-tauri/src/`、`src-tauri/ui/`、`src-tauri/tauri.conf.json` —— 对照的 Tauri 封装
- `docs/dsh-gui/2026-09-13-desktop-api-and-migration.md` —— 桌面 API 与迁移面（另一路分析）
