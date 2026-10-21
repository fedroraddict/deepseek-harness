---
kind: upgrade-guide
description: "Execution packages require the sandbox runtime peer to enforce host-secret exclusions."
---

# Execution packages require the sandbox runtime peer

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-fs-local`, `@deepseek-ai/dsh-tool-fs-search`, `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-lsp-stdio`, and `@deepseek-ai/dsh-workspace-changes` require `@deepseek-ai/dsh-sandbox` at runtime. Applications that previously omitted this peer must include it. With configured host-secret exclusions, external child providers are rejected before startup; continuable in-process children share the application’s protection.

## Migration

1. Add `@deepseek-ai/dsh-sandbox` to the application’s `package.json`, using the same release version as the execution packages, and run the package manager’s install command.
2. Confirm `pnpm why @deepseek-ai/dsh-sandbox` finds the runtime peer and the application starts without missing-module errors.
3. If enabling host-secret exclusions, use continuable in-process child providers; external child providers remain unavailable until they support exclusion propagation.
