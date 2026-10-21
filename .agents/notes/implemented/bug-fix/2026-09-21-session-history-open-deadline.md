# Agent Note: A Session's opening history window has a deadline

Status: implemented

English | [中文](2026-09-21-session-history-open-deadline.zh.md)

## Problem

A Session's history opens as one `session/follow` stream whose first frame carries the complete opening page. The Client moves `openState` to `loading` before that frame and leaves `loading` only when the frame arrives or the stream fails. Nothing bounded that wait: the Gateway journal stream, the logical Remote stream, the mux socket, and the Host pump all await without a deadline.

A carrier that accepts the follow and then stays silent leaves the retained view on "Loading history…". `Session.open()` memoizes that pending attempt, so repeated calls on the same Session object share an unresolved promise. Replacing the retained generation can cancel it, but leaving the view selected produces no error state or diagnostic.

## Decision

`Session` bounds the opening frame alone. The [Session Controller](../../../../packages/api/session-controller/README.md) resolves `openWarnMs` (default 10000) and `openTimeoutMs` (default 30000) from `history-open-config.ts` and races the opening against that deadline in `Session.doOpen`.

On expiry the Client disposes the silent stream and fails the open with `session/open-timeout`, which lands in the existing `error` state: the Chat view renders its ordinary `chat.loadError` card, and the cleared `openPromise` lets a later `open()` start a fresh attempt. The warning fires without cancelling, so a slow open that still delivers within the deadline succeeds. Both timers are cleared once the opening window is installed, so a long silence later in the transcript is never cut.

The Host publishes the resolved timing as `__DSH_SESSION_OPEN__` through `webserver/index-inject`, the served-page channel that also carries connection recovery timing. The Client plugin has no Loader configuration of its own, and its browser half reads the global with the shared defaults when a page is not Host-served.

## Alternatives considered

**A fixed constant in the Client.** No served-page plumbing, but the wait a deployment tolerates depends on its Host and its storage, so it belongs in validated configuration.

**Bound every frame.** Cutting a live Session on any quiet period would drop frames that a slow model legitimately produces; only the opening frame has a known expected latency.

**Retry the open automatically.** A silent carrier is not a transient the Client can classify, and an automatic retry loop reports the condition later instead of making it visible.

## Consequences

An unresponsive Host produces an error and a recoverable Session instead of an eternal spinner. In exchange, a Host that needs longer than `openTimeoutMs` to read a Session's log reports an error until a deployment raises the bound.

## Verification

`session-open-deadline.client.spec.ts` uses a controlled clock to verify deadline cancellation, late-frame suppression, retry, warning order, and timer cleanup on success or disposal. Its negative control bypasses the deadline and retains `openState: 'loading'` past the configured bound. `history-open-injection.host.spec.ts` and `session-open-page-config.client.spec.ts` verify the Host and Client halves of the served-page settings. `apps/web/tests/session-history-open-deadline.expected.e2e.ts` records the loading hint and timeout failure rendered by the built Client through the keyless assembled Web entry.

## Related

[Client Session references](../architecture/2026-09-15-client-session-references.md) owns `SessionReference.ready`, which settles on this open result without adding presentation. The deadline keeps that contract: a bounded failure settles readiness into `openState: 'error'` and adds no UI of its own.
