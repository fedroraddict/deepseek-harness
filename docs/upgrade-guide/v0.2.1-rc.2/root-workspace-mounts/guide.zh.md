---
kind: upgrade-guide
description: "Linux 根工作区沙箱使用独立的进程、设备和临时目录挂载。"
---

# 根工作区的临时文件相互隔离

[English](guide.md) | 中文

## 变更

在使用 Bubblewrap 的 Linux 上，`workspaceRoot: /` 的 `workspace-write` 模式使用独立的 `/proc`、`/dev` 和 `/tmp` 挂载。此前，根工作区绑定会覆盖这些挂载，暴露宿主进程和设备条目，并将写入保留在宿主 `/tmp` 中。沙箱 `/tmp` 中创建的文件会在该进程退出后消失。

## 迁移

1. 如果命令需要保留输出，请将其写入 `/tmp` 之外的明确工作区目录，并从该目录读取。
2. 再次运行命令，确认沙箱进程退出后，所选路径中仍存在输出文件。
