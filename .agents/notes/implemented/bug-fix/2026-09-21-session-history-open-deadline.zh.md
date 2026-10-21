# Agent Note: Session 的首帧历史窗口有超时上限

Status: implemented

[English](2026-09-21-session-history-open-deadline.md) | 中文

## Problem

Session 的历史通过一条 `session/follow` 流打开，其首帧携带完整的首屏页面。Client 在该帧到达前把 `openState` 置为 `loading`，只有帧到达或流失败才离开 `loading`。这条链路原本没有任何等待上限：Gateway 的 journal 流、逻辑 Remote 流、mux socket 以及 Host 的 pump 都是无期限地等待。

如果 carrier 接受了 follow 却始终不发送首帧，被保留的视图会停留在 "Loading history…"。`Session.open()` 会记住这次未决的尝试，同一 Session 对象上的重复调用因此共享一个未兑现的 Promise。替换被保留的代次可以取消它，但让该视图一直保持选中不会产生错误状态或诊断信息。

## Decision

`Session` 只给首帧设置上限。[Session Controller](../../../../packages/api/session-controller/README.zh.md) 从 `history-open-config.ts` 解析 `openWarnMs`（默认 10000）与 `openTimeoutMs`（默认 30000），并在 `Session.doOpen` 中让打开操作与该上限竞速。

超时后，Client 释放这条沉默的流，并以 `session/open-timeout` 使本次打开失败，进入既有的 `error` 状态：Chat 视图渲染常规的 `chat.loadError` 卡片，被清除的 `openPromise` 则让后续 `open()` 能开始新的尝试。告警只记录日志、不取消打开，因此仍能在上限内送达的慢速打开不受影响。首屏窗口装载完成后两个计时器都会清除，所以后续对话中间的长静默不会被截断。

Host 把解析后的时序通过 `webserver/index-inject` 以 `__DSH_SESSION_OPEN__` 页面全局下发，与连接恢复时序使用同一条 served-page 通道。Client 插件自身没有 Loader 配置，当页面并非由 Host 提供时，其浏览器半边使用共享默认值读取该全局。

## Alternatives considered

**在 Client 中写死常量。** 省去 served-page 的下发链路，但一次部署能容忍的等待取决于其 Host 与存储，因此应放在受校验的配置里。

**对每一帧都设上限。** 按任意静默期切断实时 Session，会丢弃慢速模型正常产生的帧；只有首帧有已知的预期延迟。

**自动重试打开。** 沉默的 carrier 不是 Client 能判定的瞬时故障，自动重试循环会把该状态推后暴露，而不是让它可见。

## Consequences

无响应的 Host 会给出错误和可恢复的 Session，而不是永久的 spinner。代价是：若 Host 读取 Session 日志确实需要超过 `openTimeoutMs`，在部署调高该上限前会显示为错误。

## Verification

`session-open-deadline.client.spec.ts` 使用受控时钟，验证超时取消、忽略迟到帧、重试、告警顺序以及成功或释放后的计时器清理。其反例绕过超时限制，使 `openState: 'loading'` 在配置上限之后仍保持不变。`history-open-injection.host.spec.ts` 与 `session-open-page-config.client.spec.ts` 分别验证页面设置的 Host 和 Client 两侧。`apps/web/tests/session-history-open-deadline.expected.e2e.ts` 通过无需密钥的 Web 装配入口，记录构建后的 Client 呈现的加载提示和超时错误。

## Related

[Client Session references](../architecture/2026-09-15-client-session-references.zh.md) 规定了 `SessionReference.ready`：它跟随本次打开结果兑现，且不新增任何呈现。本超时保持该契约——有上限的失败会把 readiness 兑现为 `openState: 'error'`，自身不添加 UI。
