# Architecture

The plugin registers provider `jetbrains` and integration `jetbrains-junie-oauth` through OpenCode's native plugin API. `src/index.ts` owns registration, validated options, scoped hooks, and cleanup. It does not own a token database, inference driver, or quota daemon.

## Authentication and inference

`src/oauth.ts` implements PKCE with a state-checked loopback callback, bounded token exchange, cancellation, and in-process single-flight refresh. OpenCode owns credential persistence and cross-process refresh coordination. Junie CLI credentials are never imported.

`src/inventory.ts` selects native Anthropic, OpenAI Responses, Google, or xAI drivers and their effort settings. Those drivers handle SSE, reasoning, tools, and usage; the plugin does not translate streams. Advertised input/output support is text only.

`src/transport.ts` validates the gateway, method, route, and configured model before rebuilding authentication headers. It restricts Anthropic fields, disables redirects, combines cancellation with a deadline, and sanitizes unsuccessful HTTP responses. Errors inside successful streams remain the native driver's responsibility. Provider hooks disable automatic retries; there is no account, license, or endpoint fallback.

**Host boundary:** OpenCode 2.2.5 does not preserve the hook's redirect policy and signal through its HTTP conversion. The [prepared host correction](docs/host-transport-blocker.md) is not installed by this plugin. Plugin tests do not prove that the installed host is safe for inference.

## Catalog and storage

1. Explicit `jetbrains-junie/refresh` RPC resolves the active OAuth connection and fetches fixed-origin, bounded metadata through `src/catalog.ts`.
2. `src/inventory.ts` reconciles listings with `src/static-catalog.ts`, the embedded Junie 3959.5 inventory. Exact IDs take precedence; dated aliases must be unambiguous. Unlisted models are omitted, not guessed.
3. `src/discovery.ts` validates and stores sanitized snapshots in native plugin-namespaced storage, scoped to connection, routing, schema, and metadata source. Account changes invalidate the published inventory; checks before and after asynchronous work prevent cross-account publication.
4. Other locations restore the same account's snapshot. Events and a 15-second local-storage check synchronize it without startup HTTP requests. After 24 hours, status reports stale metadata; it does not refresh automatically.

RPCs `status` and `catalog` expose cache state and provenance. Listed limits override embedded limits; unknown output limits remain null in catalog metadata. Listings do not establish inference entitlement, and account prices are unknown. See [catalog provenance](docs/catalog-provenance.md).

## Balance and optional panel

`src/quota.ts` reads only the fixed Junie `/auth/test` endpoint using the active OAuth connection. It projects balance metadata, never identity fields. Credit units divide by 100,000; USD is unscaled. Unsupported or missing values remain unavailable. No allocation, percentage, spending, or reset date is inferred.

The optional panel path is:

```text
quota consumer → loopback adapter → native quota RPC → Junie metadata
```

`src/quota-bridge.ts` accepts authenticated `GET /quota` on `127.0.0.1` and emits only `quota-v1` balance/status data. Method, path, Host, Origin, body, and independent Bearer-key checks precede balance retrieval. Requests, connections, bodies, and shutdown are bounded.

`src/quota-adapter.ts` discovers the native service on every authenticated request and invokes only the quota RPC for an explicit project location. It does not cache balances or receive JetBrains OAuth tokens. Service credentials are restricted to loopback RPC dispatch. `src/cancellation.ts` shares prompt abort rejection for operations that ignore cancellation, without replacing each caller's resource cleanup.

The adapter is externally managed, not tied to a project plugin lifecycle. The legacy `quotaBridge` option only describes its URL in status (`running: null`). Linux scripts protect the separate key file and manage a transient user service; it is not reboot-persistent. See [quota operations and validation](docs/quota.md).

## Verification boundary

`test/` covers OAuth, catalog reconciliation and cache isolation, native driver behavior, request restrictions, quota parsing, and the loopback adapter. `scripts/quota-adapter.test.mjs` checks wrapper behavior with fake processes and files. Tests use fake credentials and local listeners, not real JetBrains inference. Check commands and contribution requirements are in [CONTRIBUTING.md](CONTRIBUTING.md).
