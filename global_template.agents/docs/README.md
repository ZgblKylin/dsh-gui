# docs/

用户级参考文档目录：构建时从 `global_template.agents/docs/` 安装到 `<DSH_HOME>/docs/`。普通文件按「已存在不覆盖」安装（用户对已安装副本的修改会保留），`awesome-design-md/` 例外。

- `行文规范.md` — 文档、大段代码注释与 git 提交信息的行文规范。
- `awesome-design-md/` — 第三方只读设计参考资料，来自 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 子模块的 `design-md/` 目录：按开发者站点整理的 DESIGN.md（Google Stitch 提出的纯文本设计系统文档，可直接放进项目让 AI agent 生成视觉一致的 UI）。构建时该目录内容整体覆盖到本位置，不保留旧文件或本地修改；做 UI / 视觉效果相关任务时按需读取对应站点的设计语言。
