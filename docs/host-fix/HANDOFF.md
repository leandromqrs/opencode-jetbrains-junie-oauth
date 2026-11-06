# Isolated OpenCode host correction

## Provenance

- Official repository: https://github.com/anomalyco/opencode
- Package: `@opencode/core@2.2.5`, repository directory `packages/core`.
- npm SLSA publication attestation names commit `958f965d35ed44d32b018fd55b02a5357a7748fd` on `refs/heads/dev`.
- Original source: https://raw.githubusercontent.com/anomalyco/opencode/958f965d35ed44d32b018fd55b02a5357a7748fd/packages/core/src/session/model-request.ts
- npm metadata, original attestation, decoded statement, source baseline, and checksums are included. Attestation signatures were not independently verified.
- The source commit's package.json says 2.2.4; the publication attestation associates this commit with the published 2.2.5 artifact. The affected bridge matches the published 2.2.5 implementation structurally. No matching git tag was assumed.

## Patch

`source-fix.patch` adds one scoped fetch-options helper, calls it around the existing HTTP handler, and adds focused regression tests. Apply from the official source repository root with `git apply /absolute/path/source-fix.patch` after reviewing the diff. Nothing has been applied to an installed host.

The helper scopes `FetchHttpClient.Fetch` to this handler invocation, delegates to the inherited fetch implementation, sets the final Web Request's redirect policy, and combines its AbortSignal with the transport's own signal. It does not modify global fetch or replace the native Anthropic protocol/decoder. Existing FetchHttpClient options survive. Combining signals preserves Effect cancellation as well as plugin cancellation/deadlines, including response-body streaming after headers.

This targets the verified FetchHttpClient-backed OpenCode host transport, not arbitrary third-party HttpClient implementations.

## Focused validation

Commands run from this directory:

```sh
./node_modules/.bin/tsx --test patched/packages/core/test/session/model-http-options.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.json
git apply --check --directory=baseline source-fix.patch
```

- RED: the uncorrected bridge accepted a local 303, so the refusal regression failed with `Missing expected rejection` (`red.log`).
- GREEN: six focused tests passed (`focused-tests-final.log`). Actual local HTTP 303 and 307 responses fail without reaching the redirect target; a deadline aborts the active fetch and closes its connection; pre-abort prevents dispatch; post-header abort stops response consumption; native Effect cancellation and inherited fetch options remain effective.
- Helper and regression-test TypeScript checking passed (`focused-typecheck.log`). Patch applicability check passed (`patch-apply-check.log`).
- Tests use Node 22 and the existing isolated dependency set; exact versions are recorded in `validation-versions.json`. `node_modules` is a symlink to `/tmp/opencode/jetbrains-deps/node_modules`, not a dependency installation into any user project. The harness package.json pins its small reproducible dependency set for an independent install.

## Limits and safety

This is a source-level patch plus a focused real-fetch transport harness. No complete monorepo checkout/build, full-host typecheck, rebuilt OpenCode binary, or end-to-end patched CLI execution was performed. Bun execution remains to be checked before installing a rebuilt host. Source integration is a one-line call around the exact existing handler; the tests exercise the same fromWeb/bodyUint8Array conversion and final FetchHttpClient path, not a complete Session runtime.

The installed OpenCode is unchanged and still has the original redirect bug. Real JetBrains inference remains blocked pending host review/build/verification. No plugin source/README, global configuration, real credentials, JetBrains auth/inference endpoint, or unrelated checkout was touched. No commits, pushes, PRs, or proxy were created. Credential persistence atomicity is unrelated and remains unverified.
