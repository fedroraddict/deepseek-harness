---
kind: upgrade-guide
description: "执行包需要沙箱运行时 peer 依赖，以实施宿主秘密目录排除。"
---

# 执行包需要沙箱运行时 peer 依赖

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-fs-local`、`@deepseek-ai/dsh-tool-fs-search` 、`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-lsp-stdio` 和 `@deepseek-ai/dsh-workspace-changes` 在运行时需要 `@deepseek-ai/dsh-sandbox`。此前省略此 peer 依赖的应用必须将其加入。配置宿主秘密目录排除后，外部子提供方在启动前会被拒绝；可继续的进程内子代理共享应用的保护。

## 迁移

1. 在应用的 `package.json` 中加入 `@deepseek-ai/dsh-sandbox`，使用与执行包相同的发布版本，然后运行包管理器的安装命令。
2. 确认 `pnpm why @deepseek-ai/dsh-sandbox` 能找到该运行时 peer 依赖，且应用启动时没有模块缺失错误。
3. 启用宿主秘密目录排除时，使用可继续的进程内子提供方；外部子提供方在支持排除传递前仍不可用。
