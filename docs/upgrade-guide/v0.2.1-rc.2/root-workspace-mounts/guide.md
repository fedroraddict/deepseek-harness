---
kind: upgrade-guide
description: "Linux root-workspace sandboxes use private process, device, and temporary mounts."
---

# Root-workspace temporary files are isolated

English | [中文](guide.zh.md)

## Change

On Linux with Bubblewrap, `workspace-write` with `workspaceRoot: /` uses private `/proc`, `/dev`, and `/tmp` mounts. Previously the root workspace bind replaced these mounts, exposing host process and device entries and persisting writes to host `/tmp`. Files created in the sandbox’s `/tmp` disappear when that process exits.

## Migration

1. If a command must persist output, write it to an explicit workspace directory outside `/tmp` and read it from that directory.
2. Run the command again and confirm its output exists at the chosen path after the sandboxed process exits.
