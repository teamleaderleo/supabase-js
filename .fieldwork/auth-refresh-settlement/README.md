# Auth refresh notification settlement lab

This branch compares two bounded changes to `GoTrueClient` at commit `63318987365bbcea2c31a00b62cbb95b21083ad5`.

The branch is an owned-fork experiment. It does not contact Supabase maintainers and does not modify the checked-in auth client directly. The runner applies one patch to a clean checkout, copies focused Jest tests into auth-js, executes them against the real package code, and restores the checkout afterward.

## Why this boundary

A manual refresh currently follows this order:

1. fetch and validate rotated credentials;
2. pass the storage and removal guards;
3. save the rotated session;
4. await every `TOKEN_REFRESHED` subscriber;
5. resolve the shared refresh `Deferred`;
6. return the refresh result.

That creates two coupled success-path failures:

- a subscriber that awaits `refreshSession()` can join the unresolved outer refresh and form a promise cycle;
- a subscriber exception can turn a committed refresh into a caller-visible rejection and can reject the internal `Deferred` without a joiner.

A callback that throws an `AuthError` exposes a stronger consequence. The outer `_callRefreshToken` catch can classify that application callback error as a token-refresh failure. When the old access token has expired, current code can remove the newly stored rotated session and cache the callback error under the old refresh token.

Callbacks must remain awaited. `@supabase/ssr` uses an async auth callback to flush cookie changes before a server response completes. Earlier fire-and-forget notification changes caused OAuth cookie regressions.

Initialization adds another path. `TOKEN_REFRESHED` may be queued until `initializePromise` resolves. When the queued callback eventually runs, the original refresh is already finished. A fix tied only to the active refresh promise misses this case and can allow a callback to request an unnecessary second rotation.

Both variants therefore expose the current event session during the actual `TOKEN_REFRESHED` notification. A no-argument nested `refreshSession()` reads that rotated token from storage and receives the event result without another service call. This also covers queued initialization and cross-tab delivery.

## Variant A: early shared settlement

Patch: `patches/early-shared-settlement.patch`

After the rotated session is saved, the client creates the success result, clears the failure cache, and resolves the shared refresh `Deferred` before awaiting subscribers. The initiating refresh still awaits subscriber completion. During the notification, the event session is also available for queued and cross-tab callbacks. Subscriber exceptions are logged and isolated for `TOKEN_REFRESHED` only.

Expected properties:

- default nested refresh calls receive the committed event session;
- an explicit nested call carrying the old token receives the resolved shared result during a manual refresh;
- one token request occurs;
- queued initialization and cross-tab callbacks avoid a second rotation;
- the initiating refresh waits for SSR-like async callback work;
- every concurrent joiner can observe the committed result before subscriber completion, including callers carrying the old token.

The final point is the main compatibility cost. It changes the timing of ordinary joiners that have no relationship to the callback.

## Variant B: notification-scoped committed result

Patch: `patches/token-aware-committed-result.patch`

The shared refresh `Deferred` keeps its current settlement timing. While `TOKEN_REFRESHED` callbacks are actually running, calls carrying the event's rotated token receive that committed event result. This works whether the event came from a manual refresh, the initialization queue, or another tab. Subscriber exceptions are logged and isolated for `TOKEN_REFRESHED` only.

Expected properties:

- the common no-argument nested `refreshSession()` path reads the rotated token from storage and receives the event result;
- queued initialization and cross-tab callbacks avoid a second rotation;
- old-token concurrent callers preserve existing wait timing;
- an explicit nested call carrying the old token still forms the original manual-refresh cycle.

The final point is the main completeness cost. The variant handles the normal public usage while leaving an explicitly stale-token reentry unresolved.

## Separate failure-path finding

A non-retryable refresh failure with an expired access token calls `_removeSession()` before resolving the shared refresh `Deferred`. `_removeSession()` awaits `SIGNED_OUT` subscribers. If one of those subscribers throws, the initiating `_callRefreshToken()` rejects with the subscriber error, but the existing shared Deferred is neither resolved nor rejected before the `finally` block drops its reference. Concurrent refresh joiners can remain pending indefinitely.

The focused lab now records this negative result. It is not repaired by either success-path settlement variant and should remain a separate candidate because it belongs to refresh-failure teardown and total Deferred settlement rather than `TOKEN_REFRESHED` result ownership.

`dispose()` is also kept separate. Current source and the lockless migration document explicitly state that disposal does not abort in-flight fetches and that a disposed client may still persist a rotated session. A lifecycle generation fence would change a documented contract rather than repair an undocumented defect.

## Historical constraints

- Supabase JS PR 2014 deferred one notification with `setTimeout(0)` and was later reverted by PR 2039 after SSR OAuth cookie writes could miss the response.
- PR 2016 proposed globally non-blocking subscribers and was closed because awaited SSR callbacks carry required cookie work.
- PR 2392 removed the default lock and deliberately retained awaited subscribers, while documenting this residual refresh cycle.
- PR 2498 solved the related initialization cycle by allowing the shared initialization dependency to settle before queued callbacks run, while the initiating `initialize()` call still waits for callback completion. Variant A follows that precedent.
- PR 2477 proposed warning on every async callback. It was closed because async callbacks are valid and are used by `@supabase/ssr`; the maintainer comment preferred behavior at the actual refresh reentry point.
- Issue 2037 demonstrates that a server response can outlive neither a deferred cookie callback nor a macrotask workaround. The initiating auth call must retain callback completion in its await chain.
- Issue 2491 and PR 2498 demonstrate a second kind of cycle: a callback can depend on an internal promise that the callback itself prevents from settling. Their accepted fix moved callback execution after that dependency settled while preserving callback waiting by the public operation.

## Guardrails and anti-patterns

The experiment rejects these directions:

- globally fire-and-forget auth subscribers;
- `setTimeout(0)` or `queueMicrotask` as a correctness boundary;
- warning on every async callback;
- blanket swallowing of notification transport failures;
- changing error behavior for auth events other than `TOKEN_REFRESHED` in the first candidate;
- issuing a second token rotation from inside `TOKEN_REFRESHED` merely to retrieve the session carried by the event;
- relying on incidental microtask order without testing it;
- changing every auth event when the reproduced success-path problem belongs to refresh settlement;
- introducing Node-only async-context APIs into browser client code;
- assuming a callback can be identified from another concurrent caller without an explicit public context contract.

## Test matrix

The focused Jest files check:

1. nested no-argument `refreshSession()` returns the stored rotated session;
2. the token service stub runs once;
3. a throwing subscriber is logged, all subscribers run, refresh returns success, and no unhandled rejection appears;
4. an SSR-like async subscriber completes before the initiating refresh returns;
5. old-token concurrent caller timing distinguishes the variants;
6. explicit old-token nested refresh distinguishes completeness;
7. queued initialization callbacks receive the event session without a second rotation;
8. cross-tab callbacks receive the event session without a second rotation;
9. non-refresh subscriber failures keep their existing rejection behavior;
10. BroadcastChannel transport failures remain visible;
11. stored credentials and returned credentials agree;
12. an `AuthError` thrown by a successful refresh listener cannot erase the rotated session or populate refresh-failure cooldown state, under both `throwOnError` modes;
13. a throwing `SIGNED_OUT` listener during expired-session refresh failure can leave a concurrent joiner pending, recorded as a separate negative result.

The executable model records the central success-path timing distinction without package dependencies. It supports the design comparison but does not replace the real Jest matrix or the new failure-path characterization.

## Run

The GitHub Actions workflow runs both patches as a matrix. Local commands:

```bash
bash .fieldwork/auth-refresh-settlement/run.sh early-shared-settlement
bash .fieldwork/auth-refresh-settlement/run.sh token-aware-committed-result
```

Distinguishing assertions:

- Variant A: old-token joiner settles early; explicit old-token nested refresh succeeds.
- Variant B: old-token joiner waits; explicit old-token nested refresh times out in the bounded probe.
- Both variants: successful `TOKEN_REFRESHED` callback errors remain separate from auth-refresh errors; the distinct `SIGNED_OUT` teardown orphan remains characterized and unresolved.