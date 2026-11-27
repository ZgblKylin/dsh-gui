# 递归删除与 Windows junction 穿透

## 结论

本仓库禁止直接调用 `fs.rmSync(path, { recursive: true })` 删除任何目录树，一律改用 `scripts/remove-tree.mjs`：

- `removeTree(path, { retries, retryDelayMs })`：安全递归删除，遇到链接只摘链接、不进入目标，缺失路径视为无操作。
- `removeLink(path)`：只摘一个链接，路径不是链接时抛错（避免把真实目录当链接删掉）。
- `isLinkPath(path)`、`hasLinkedAncestor(root, target)`：前者判断路径本身是否为链接，后者判断删除目标是否要穿过某层链接（穿过就说明会落到别的目录树里）。

## 原因

Node 在 Windows 上把 junction 视为符号链接（`lstat().isSymbolicLink()` 为 true），但 `fs.rmSync(..., { recursive: true })` 不会先摘掉它，而是进入它指向的目录继续删。实测（Windows 11 / 同一台机器）：

| 运行时 | `rmSync(含 junction 的目录, { recursive: true })` | `rmSync(junction 路径, { recursive: true })` |
|---|---|---|
| Electron 自带 Node（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`，报告 v24.22.3） | 链接目标目录**保留**，目标里的文件**全部删除** | 同上 |
| 官方 Node v24.19.0（系统安装） | 只摘链接，目标不受影响 | 只摘链接 |
| 官方 Node v24.22.3（desktop runtime 的 `primary-runtime/dependencies/node`） | 只摘链接，目标不受影响 | 只摘链接 |

`unlinkSync(junction)` / `rmdirSync(junction)` 在三种运行时里都只摘链接。

这个差异决定了危险路径：`npm run build` / `npm run test:scripts` 等由终端里的官方 Node 执行，同样的代码不会出事；而**应用内更新（`dsh-auto-update`）用 `process.execPath` 也就是 Electron 启动插件安装脚本**，落到的正是会穿透的那一个运行时。同一段代码在终端里验证正常、在应用内触发才误删，这也是它一直没被发现的原因。

被删的目录本身还在、`CreationTime` 不变、内容全空——只看目录属性无法判断它被删过。若目标本身是 profile 的 `node_modules`，下一次启动就表现为所有第三方 bundle “cannot resolve profile bundle”。

## 本仓库里的风险点

- profile（`.dsh/profiles/<name>/node_modules`）里每个 in-tree 插件都是指向 `plugins/<id>/<package>` 的 junction。删 profile 里的任何路径都可能顺带清空仓库里的插件源码。
- `.staging/` 运行时根的 profile 通过 junction 指向主检出；删除验证工作区时同样会穿透。
- `scripts/plugin-install.mjs` 的“删除包内残留 `node_modules`”只应作用于 npm 安装的真实目录；对 `link:` 安装，那个 `node_modules` 属于插件源码树（其构建依赖），删除即误删。
- remote tab 的子 home（`.dsh/gui/remote-tabs/<id>/home`）把 `profiles/remote-tab/node_modules` 做成指向**宿主 profile 依赖树**的 junction（`src/remote-tab/profile.ts`）。遗忘这个 tab 时删除整个子 home，就会把宿主 profile 的依赖删空。

## 2026-11-27 的实际链路

desktop profile 的第三方插件全部报 `cannot resolve profile bundle`，`node_modules` 目录还在、内容全空、`CreationTime` 未变。现场证据：

- `.dsh/gui/remote-tabs/remote-d6f1f2cf-…` 目录创建于 `11:56:07`、最后写入 `11:56:34`（与清空同秒），且已是空目录；
- 另一个存活的 remote tab 的 `profiles/remote-tab/node_modules` 是指向 `.dsh/profiles/desktop/node_modules` 的 junction；
- 同一 fixture 的负向对照（Electron Node）：`rmSync(childHome, { recursive: true })` 删除目标里的文件、保留目标目录；官方 Node 下目标不受影响。

即：关闭 remote tab → `RemoteTabSupervisor.forget()` 删除子 home → Electron 的 Node 跟穿 `node_modules` junction → 宿主 profile 的依赖被清空 → 应用重启后所有第三方 bundle 无法解析。终端里复现不了，是因为 `npm run …` 用的是官方 Node。

两部分都已改为链接安全删除：主仓脚本用 `scripts/remove-tree.mjs`，`dsh-desktop-tabs` 用 `src/remote-tab/remove-tree.ts`（该包必须能独立加载，不能引用仓库脚本）。

## 约束

- 新增会递归删除的代码时只用 `removeTree` / `removeLink`；需要“删之前确认不会穿过链接”时用 `hasLinkedAncestor` 并在穿过时放弃操作。
- 只删链接的场景不能写成 `removeTree(link)`（虽然它是安全的），因为意图不明确；用 `removeLink` 让“必须删除的是链接”成为断言。
- in-tree 插件不能 import 仓库脚本（要能独立加载），在自己的包里放同语义的实现，并补一条 spec。
- 回归测试：`scripts/remove-tree.test.mjs`（`npm run test:scripts`）与 `plugins/desktop-tabs/dsh-desktop-tabs/tests/remote-tab-supervisor.spec.ts`（含 forget 不得穿过链接的断言）。
