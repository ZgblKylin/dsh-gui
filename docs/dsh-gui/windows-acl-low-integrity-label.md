# Windows 工作区低完整性标签

本文说明 `@deepseek-ai/dsh-sandbox-windows-acl` 在 Windows 上建立 `workspace-write` 写边界时给会话工作区留下的三类持久授权，以及当工作区内含有可执行文件、DSH home 与运行时目录时由此产生的后果。

## 授权的内容

该后端给**会话工作区根**写入一次安全描述符变更，其中包含三项彼此绑定的授权：capability SID 的允许 ACE、父目录 `FILE_DELETE_CHILD` 对 world SID 的拒绝 ACE，以及一个**低完整性标签**。三者由同一次 `SetNamedSecurityInfoW` 调用写入。

标签带有容器与对象继承标志，因此工作区的每个后代都继承它。工作区根的标签是**常驻**的：授权只在首次为某个工作区建立时物化一次，后续会话、调用与重启命中「精确 ACE 已存在」的跳过分支，标签不会被撤销。

该后端另给每对「会话 × 工作区」分配一个随机私有临时目录，并为它写入一份可撤销的独立授权。工作区之外的目录不会获得这些授权。

## 进程完整性来自镜像文件标签

Windows 依据可执行镜像文件的完整性标签确定新建进程的完整性等级：可执行文件带低标签时，其进程以低完整性运行，该进程随后派生的所有子进程沿用它继承到的令牌。

实测对照：把 `C:\Windows\System32\cmd.exe` 分别复制到工作区内与工作区外，两者由同一个普通权限的 PowerShell 启动。工作区内的副本报告 `Mandatory Label\Low Mandatory Level`，工作区外的副本报告 `Mandatory Label\Medium Mandatory Level`。两处差异只有目标目录的可继承标签。

复制不会携带标签，标签按目标父目录的可继承标签决定。实测：把工作区内一个带低标签的文件复制到工作区外，副本没有标签。

因此受影响的是**工作区内的可执行文件**，而不是工作区内的数据文件：低标签目录对中等完整性进程仍然可写，所以 harness、构建工具与编辑器读写工作区内的源码、`node_modules`、会话数据都不受影响。

## 低完整性对写入边界的影响

低完整性进程不能写入未打标签（等效中等完整性）的目录，即使该目录的 DACL 授予它完全控制。`dsh-sandbox-windows-acl` 的授权模型由此要求：受控子进程只能写入被显式打标签的目录，即工作区与它自己的私有临时目录。

当运行 harness 的进程本身是低完整性时，它自己也需要一个可写的环境临时根。环境临时根从不被隐式授权，未打标签时低完整性进程无法在其中建立目录，于是出现以下连锁结果：

- `@deepseek-ai/dsh-spill-local` 在激活阶段执行 `mkdtemp(<tmpdir>/dsh-spill-)` 失败，加载器报告 `1 entry did not activate`。
- 需要临时目录的子进程无法启动，`pwsh`、`grep`、`glob` 一路返回 `ripgrep launch failed` 或 `EPERM mkdir`。
- 后端在 `%TEMP%\dsh-acl-locks\` 下创建 ACL 串行锁失败，错误为 `CreateFileW failed (Win32 5)`。

要让这条链路恢复，环境临时根必须同时满足三项条件：位于工作区之外（后端拒绝工作区等于或包含临时根）、对低完整性令牌可写（带低标签）、并且授予 `Everyone` 完全控制（授权物化需要 `WRITE_OWNER`，只有完全控制包含该权限）。授予 `Modify` 不足以通过受限令牌的第二次访问检查。

## 单用户机器上的实际影响面

工作区内含可执行文件时，这些文件被启动后都以低完整性运行。以下为实测清单与其影响。

| 位置 | 可执行文件 | 启动方 | 影响 |
|---|---|---|---|
| 仓库根 | `dsh-gui.exe` | 用户 | 整棵进程树降为低完整性，触发上述全部症状 |
| `.harness\node_modules\@vscode\ripgrep-win32-x64\bin` | `rg.exe` | grep 工具 | 只读工具，可正常工作 |
| `.harness\node_modules\node-pty\**` | `OpenConsole.exe` | 终端类功能 | 依赖控制台与管道，未逐一验证 |
| `.harness\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin` | `libreoffice-kit.exe` | 文档转换类功能 | 需要写自身的用户配置与临时目录，位于工作区之外时不可用 |
| `plugins\dsh-web-ui\...\@esbuild\win32-x64` | `esbuild.exe` | 插件构建脚本 | 产物写回工作区，可正常工作 |
| `plugins\dsh-web-ui\...\cloudflared` | `cloudflared.exe` | 远程连接 | 需要写 `%USERPROFILE%\.cloudflared`，位于工作区之外时不可用 |
| `plugins\*\...\ssh2\util` | `pagent.exe` | ssh2 的 Pageant 分支 | 未验证 |

此外，低标签把工作区内的**代码**对任何低完整性进程开放写入，其中包括 `node_modules` 与 profile 中的插件代码；这些代码随后由中等完整性的 harness 执行。

## 硬链接导致的标签外溢

pnpm 默认以硬链接把仓库内 store 的文件链接进 `node_modules`。硬链接共享同一个文件对象，因此也共享同一份安全描述符。实测别名关系如下。

```
rg.exe               .pnpm-store\v11\files\18\48d0…  +  deepseek-harness\node_modules\.pnpm\…\rg.exe  +  .harness\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe
esbuild.exe          .pnpm-store\v11\files\14\66fa…  +  plugins\dsh-web-ui\dsh-web-ui\node_modules\.pnpm\…\esbuild.exe
libreoffice-kit.exe  .pnpm-store\v11\files\99\07e2…  +  .harness\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin\libreoffice-kit.exe
```

工作区的授权物化会遍历整棵子树并逐个写入标签，因此工作区内的某个别名被打标时，store 中的同一文件对象也随之变为低标签，并沿该对象的其它别名传播。把 store 移出工作区并不足以保证外层副本保持中等完整性，只要工作区内仍存在指向该 store 的硬链接。

## SmartScreen 提示

低标签同时触发 Microsoft Defender SmartScreen 的「无法识别的应用」提示。实测该 exe 的状态为：未数字签名、没有 `Zone.Identifier` 备用数据流、Smart App Control 关闭、SmartScreen 的应用与文件检查开启。

把标签恢复为中等完整性后，同一路径、同一文件名的直接启动不再出现提示；而把该 exe 复制到工作区外（副本不带标签）同样不出现提示，原文件仍出现提示。

## 恢复方式

把入口 exe 的标签恢复为中等完整性即可让它以中等完整性运行：

```powershell
icacls "<runtime-root>\dsh-gui.exe" /setintegritylevel Medium
```

写 SACL 需要 `SeSecurityPrivilege`，普通未提权的账户没有该权限（`whoami /priv` 中不出现），因此该命令需要提权执行。

工作区根的标签由后端在授权物化时写入，构建产物只要落在工作区内就会重新继承它。要让入口 exe 长期不带标签，应把它与 DSH home、运行时一起放在工作区之外，见 [nested-clone-layout.md](nested-clone-layout.md)。
