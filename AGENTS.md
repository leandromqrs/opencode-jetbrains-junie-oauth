# Repository guidance

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing module boundaries. This is a native OpenCode 2.2.5 plugin, not an OpenAI-compatible proxy.

## Checks

```sh
npm ci
npm run typecheck
npm test
npm run test:quota-adapter
npm run build
```

For a narrow quota change, start with:

```sh
npx --no-install tsx --test test/quota.test.ts test/quota-bridge.test.ts test/quota-adapter.test.ts
```

Run affected tests after each refactor. Run the complete checks before handoff unless another explicitly assigned owner is doing final integration verification. There is no separate lint script.

## Constraints

- Keep provider/integration IDs, RPC names, native drivers, effort mappings, and public options stable unless a behavior change is requested. Preserve SSE/tools/reasoning/usage and cancellation semantics.
- Preserve account-scoped snapshot validation and active-connection rechecks. Startup must not query upstream; discovery remains explicit. Never invent entitlement, pricing, Eco support, or quota totals.
- Retain destination/route allowlists, redirect rejection, body/deadline limits, auth stripping, and sanitized errors. Do not weaken checks to reduce line count. [The host transport blocker](docs/host-transport-blocker.md) still prevents real inference on the uncorrected installation.
- Keep native credentials, service state, and adapter keys outside the checkout and output. Do not inspect private token/config files, change global configuration, restart services, or run live OAuth/inference without explicit authorization. The adapter uses its own key, not a JetBrains token.
- Prefer small behavior-preserving changes and existing helpers. Keep comments for non-obvious contracts, units, and security rationale; omit narration. Do not edit generated `dist/`, weaken tests, or add dependencies for cleanup. Preserve unrelated working-tree changes; do not commit unless asked.
