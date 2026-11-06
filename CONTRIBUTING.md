# Contributing

## Setup

Use Node.js 22+ and npm. OpenCode 2.2.5 is the tested host version; tests do not require a real account or a running service.

```sh
npm ci
npm run typecheck
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) to locate the relevant boundary. Source is TypeScript ESM with `.js` import specifiers. Build output in `dist/` is generated, not edited by hand.

## Make a focused change

1. Check `git status --short` and preserve unrelated work.
2. Find the affected behavior's tests in `test/`; add a regression test before a fix. For refactoring, establish a passing baseline and keep behavior unchanged.
3. Make one small change. Prefer clear names and existing helpers; keep validation and cleanup intact. Comments should explain contracts, units, or a non-obvious reason, not narrate code.
4. Run the affected tests, then the checks below. Review correctness, readability, module boundaries, security, and resource use. Keep refactoring separate from features and dependency upgrades.

For example, quota changes can start with:

```sh
npx --no-install tsx --test test/quota.test.ts test/quota-bridge.test.ts test/quota-adapter.test.ts
```

## Before submitting

```sh
npm run typecheck
npm test
npm run test:quota-adapter
npm run build
git diff --check
```

Report what changed, why, the exact checks run, and any limitations. Tests use mocks and local listeners; passing them does not establish live inference entitlement or fix the [host transport blocker](docs/host-transport-blocker.md). There is no separate lint command.

Use English Conventional Commit subjects, such as `refactor(quota): share cancellation handling`, under 72 characters. Explain non-obvious reasons in the body. Keep commits atomic and preserve the configured author identity; do not add generated attribution.

## Security and live checks

- Use fake credentials and temporary files in tests. Never submit tokens, callback codes, service credentials, adapter keys, raw account payloads, or private logs.
- Do not read Junie CLI tokens or change native credential persistence. Preserve account-switch checks, fixed origins, redirect refusal, request bounds, and independent adapter authentication.
- Live OAuth, metadata queries, service changes, and especially inference require explicit authorization. No installation or global configuration change is part of an ordinary test run.
- Keep unavailable quota distinct from zero. Preserve the 100,000 credit conversion and do not infer totals or renewal dates. The adapter's transient Linux service needs a new start after reboot; see the [quota guide](docs/quota.md).
- Dependency changes need their own rationale, lockfile review, and checks. The previous installation recorded 24 moderate audit findings, not yet triaged; do not describe dependencies as audited or run automatic fixes as part of a cleanup.
