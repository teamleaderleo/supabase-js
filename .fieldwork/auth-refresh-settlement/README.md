# Auth refresh notification settlement lab

This branch compares two bounded changes to `GoTrueClient._callRefreshToken` at commit `63318987365bbcea2c31a00b62cbb95b21083ad5`.

The branch is an owned-fork experiment. It does not contact Supabase maintainers and does not alter the checked-in auth client implementation. The workflow applies each patch to a clean checkout, copies the dedicated Jest file into the auth-js test directory, and runs that file against the real package code.

## Why this boundary

A refresh currently follows this order:

1. fetch and validate rotated credentials;
2. pass the storage and removal guards;
3. save the rotated session;
4. await every `TOKEN_REFRESHED` subscriber;
5. resolve the shared refresh `Deferred`;
6. return the refresh result.

That creates two coupled failures:

- a subscriber that awaits `refreshSession()` can join the unresolved outer refresh and form a promise cycle;
- a subscriber exception can turn a committed refresh into a caller-visible rejection and can reject the internal `Deferred` without a joiner.

Callbacks must remain awaited. `@supabase/ssr` uses an async auth callback to flush cookie changes before a server response completes. Earlier fire-and-forget notification changes caused OAuth cookie regressions.

## Variant A: early shared settlement

Patch: `patches/early-shared-settlement.patch`

After the rotated session is saved, the client creates the success result, clears the failure cache, and resolves the shared refresh `Deferred` before awaiting subscribers. The initiating refresh still awaits subscriber completion. Subscriber exceptions are logged and isolated for `TOKEN_REFRESHED` only.

Expected properties:

- default and explicit-token nested refresh calls receive the committed result;
- one token request occurs;
- the initiating refresh waits for SSR-like async callback work;
- every concurrent joiner can observe the committed result before subscriber completion, including callers that supplied the old refresh token.

The final point is the main compatibility cost.

## Variant B: token-aware committed-result window

Patch: `patches/token-aware-committed-result.patch`

After storage commit, the client exposes the committed result only to calls carrying the newly rotated refresh token. Existing callers carrying the old token continue to join the unresolved `Deferred` until subscribers finish. Subscriber exceptions are logged and isolated for `TOKEN_REFRESHED` only.

Expected properties:

- the common nested `refreshSession()` path reads the rotated session from storage and receives the committed result;
- old-token concurrent callers preserve existing wait timing;
- an explicit nested call that supplies the old token still forms the original cycle.

The final point is the main completeness cost.

## Historical constraints

- Supabase JS PR 2014 deferred one notification with `setTimeout(0)` and was later reverted by PR 2039 after SSR OAuth cookie writes could miss the response.
- PR 2016 proposed globally non-blocking subscribers and was closed because awaited SSR callbacks carry required cookie work.
- PR 2392 removed the default lock and deliberately retained awaited subscribers, while documenting this residual refresh cycle.
- PR 2498 solved the related initialization cycle by allowing the shared initialization dependency to settle before queued callbacks run, while the initiating `initialize()` call still waits for callback completion. Variant A follows that precedent.
- PR 2477 proposed warning on every async callback. It was closed because async callbacks are valid and are used by `@supabase/ssr`; the maintainer comment preferred detection at the actual refresh reentry point.

## Guardrails and anti-patterns

The experiment rejects these directions:

- globally fire-and-forget auth subscribers;
- `setTimeout(0)` as a synchronization boundary;
- warning on every async callback;
- blanket swallowing of notification transport failures;
- issuing a second token rotation from inside `TOKEN_REFRESHED`;
- relying on incidental microtask order without testing it;
- changing every auth event when the reproduced problem belongs to refresh settlement;
- introducing Node-only async-context APIs into browser client code.

## Test matrix

The dedicated Jest file checks:

1. nested `refreshSession()` settles and returns the stored rotated session;
2. the token service stub runs once;
3. a throwing subscriber is logged, all subscribers run, refresh returns success, and no unhandled rejection appears;
4. an SSR-like async subscriber completes before the initiating refresh returns;
5. old-token concurrent caller timing distinguishes the variants;
6. explicit old-token nested refresh distinguishes completeness;
7. stored credentials and returned credentials agree.

## Run

The GitHub Actions workflow runs both patches as a matrix. A local equivalent is:

```bash
git apply .fieldwork/auth-refresh-settlement/patches/<variant>.patch
cp .fieldwork/auth-refresh-settlement/refresh-notification-settlement.test.ts \
  packages/core/auth-js/test/fieldwork-refresh-notification-settlement.test.ts
cd packages/core/auth-js
pnpm exec jest --config jest.config.cli.js --runInBand \
  test/fieldwork-refresh-notification-settlement.test.ts --coverage=false
```

Use these environment values for the distinguishing assertions:

- Variant A: `FIELDWORK_OLD_TOKEN_JOINER_EARLY=true`, `FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED=success`
- Variant B: `FIELDWORK_OLD_TOKEN_JOINER_EARLY=false`, `FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED=timeout`
