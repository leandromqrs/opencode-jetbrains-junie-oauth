# Transport blocker in OpenCode 2.2.5

## Status

Do not enable real inference. The user authorized preparing an isolated host correction, without automatically replacing the existing installation.

## Evidence

The published `@opencode/core@2.2.5` package, at `dist/chunks/location-7989c5m3.js:237–248`, transforms the `Request` returned by the `http.request` hook using `HttpClientRequest.fromWeb` before calling the HTTP handler.

Effect's `HttpClientRequest.fromWeb` implementation copies the method, URL, headers, and body, but does not preserve `Request.redirect` or `Request.signal`. The fetch layer uses its own options and signal; no equivalent redirect blocking was found in this host path.

A local-only reproduction of this conversion received an original Request with `redirect: "error"` and an aborted signal. In the final fetch, redirect was unset and the signal was not aborted. An HTTP 303 redirect was followed, with a final 200 response.

The 307 case produced an ArrayBuffer error in Node during attempted processing; this does not prove that body forwarding is protected in all environments.

## Consequence

Validating the destination before conversion does not prevent subsequent redirects. Even if a fetch removes Authorization on cross-origin redirects, conversation content must not rely on this partial protection.

The separate plugin and driver unit tests do not exercise this host bridge. The provider registration smoke test also does not validate transport security.

## Unblocking criterion

Prepare a traceable host correction and prove, in the actual HTTP dispatch path, that 303 and 307 redirects are refused before reaching the alternate destination and that cancellation/deadlines are preserved. Use only local services and fake data. The correction must not modify the installed executable without authorization.

## Prepared correction

The [validated source patch](host-fix/validated/host-fix-validated.patch) and [native validation report](host-fix/validated/VALIDATION.md) are preserved in this repository. It supersedes the preliminary `host-fix/source-fix.patch`; do not apply both. The patch scopes the fetch implementation per request, preserving the redirect policy and combining plugin and transport signals without changing global fetch.

In the isolated official checkout of commit `958f965d35ed44d32b018fd55b02a5357a7748fd`, with Bun 1.4.4, 13 focused Core tests and two additional tests with the real built plugin through the native adapter passed. The tests confirm 303/307 refusal, zero redirect-target hits, cancellation, and correct header reconstruction with fake credentials. The official source/test typecheck and Core package build also passed. The diff and patch reverse-applicability were checked.

No complete CLI executable was built or installed. The current installation remains vulnerable to this transport behavior; the result with corrected source does not make the existing executable safe. No calls were made to JetBrains services during this isolated host-patch validation.

Subsequent checks verified real OAuth login and authenticated catalog and balance queries, as described in the [README](../README.md). Those checks do not prove secure credential persistence or inference entitlement, and do not remove this transport blocker.
