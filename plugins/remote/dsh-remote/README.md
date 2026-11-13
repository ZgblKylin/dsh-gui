# dsh-remote

**本机后端 + Docker** 连接插件（DeepSeek Harness GUI）：标题栏标签页、汉堡菜单、新建连接页、
本地后端启动，以及 Docker 连接（`docker exec` 启动容器内 dsh 并桥接回环端口，**无需端口映射**）。
非侵入、自托管。

SSH 远程连接已迁到 [`dsh-desktop-tabs`](../../desktop-tabs/dsh-desktop-tabs) 的 host 半端
（`/desktop-tabs/api/*`），由 Tauri 壳与 desktop 应用共用；本插件只负责本机后端与 Docker。
旧的 `<DSH_HOME>/gui/credentials` 与 `<DSH_HOME>/gui/keys` 不再被使用，可手动清理。

详见 [docs/README.md](docs/README.md)。
