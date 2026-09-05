# AGENTS.md

## 环境/工具说明

优先使用grep工具和ripgrep命令，都不可用时才使用grep命令。

## 行文规范

编写/维护文档、大段代码注释、编写git提交的详细信息时，需要先参考`$env:DSH_HOME/.agents/docs/行文规范.md`。

## Subagent 编排规范

- 短任务：由主 Agent 直接完成，不额外编排子 Agent。
- 长任务：优先使用 `workflow` 或 `run_code` 编排 Agent Team 完成任务；主 Agent 只负责整体编排与决策，不直接进行修改/调试。

## Git 提交规范

- 采用 Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:` / `build:` / `refactor:`，正文按需使用。
- 外层仓库与 `plugins/<id>/` 子模块各自独立提交；改动跨越两者时分别编写 commit message。
- **不主动执行 `git commit`**：dsh 沙箱限制下由 dsh 生成的提交无法引用用户 GPG 签名，直接提交会绕过用户的签名配置。
- 完成代码改动后，将变更添加到暂存区（`git add`），编写 commit message，并在回复中提醒用户手动执行 `git commit`（以便 GPG 签名与提交钩子生效）。
- 提交前检查 `git status` 确认暂存范围正确；不要提交 `node_modules/`、`lib/` 等构建产物（已由 `.gitignore` 排除）。
