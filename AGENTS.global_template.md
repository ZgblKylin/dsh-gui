# AGENTS.md

## 环境/工具说明

优先使用grep工具和ripgrep命令，都不可用时才使用grep命令。

复杂任务考虑编写文档助记，并调度subagent完成。
记录草稿、验证、进度追踪等步骤生成的中间文件，在任务完成后询问用户是否清理。

## 安全说明

编写脚本、使用 bash/pwsh 等 shell 命令时，不要使用 home/HOME 等会与系统环境变量产生歧义的变量名。

## 文档参考

- `$env:DSH_HOME/docs/行文规范.md`：文档、大段代码注释与 git 提交信息的行文规范，编写这些内容前先参考。
- `$env:DSH_HOME/docs/awesome-design-md/`：第三方只读 DESIGN.md 资料集（VoltAgent 的 awesome-design-md，Google Stitch 的纯文本设计系统文档；构建时整体覆盖，不要修改），做 UI / 视觉一致性相关任务时按需读取对应站点的设计语言。

## Subagent 编排规范

- 简单任务：由主 Agent 直接完成，不额外编排子 Agent。
- 复杂/长任务：
  - 优先使用 Agent Team 执行任务，并考虑使用 `workflow` 或 `run_code` 编排并行任务；主 Agent 只负责整体编排与决策，不直接进行修改/调试。
  - 使用文档追踪多轮进度，避免上下文压缩丢失信息：
    - 任务开始前，将任务规划编写文档落地；
    - 任务过程中，通过 progress.md 追踪进度，记录每轮的输入、输出、决策和问题；
    - 任务结束后，编写总结文档，记录任务完成情况、问题和经验教训；必要时可将总结文档纳入项目文档体系，可向用户申请创建/更新 SKILL。

## 工作目录

需要代码变更时，在仓库的 `.gitignore` 忽略目录下（如bin/）使用 worktree 建立工作目录，并在工作目录中进行代码变更。

## Git 提交规范

- 采用 Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:` / `build:` / `refactor:`，正文按需使用。
- 外层仓库与 `plugins/<id>/` 子模块各自独立提交；改动跨越两者时分别编写 commit message。
- **不主动执行 `git commit`**：dsh 沙箱限制下由 dsh 生成的提交无法引用用户 GPG 签名，直接提交会绕过用户的签名配置。
- 完成代码改动后，将变更添加到暂存区（`git add`），编写 commit message，并在回复中提醒用户手动执行 `git commit`（以便 GPG 签名与提交钩子生效）。
- 提交前检查 `git status` 确认暂存范围正确；不要提交 `node_modules/`、`lib/` 等构建产物（已由 `.gitignore` 排除）。
