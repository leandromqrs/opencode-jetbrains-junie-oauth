# Native host validation

## Source and scope

Official remote: `https://github.com/anomalyco/opencode.git`.
Detached commit: `958f965d35ed44d32b018fd55b02a5357a7748fd`.
Checkout: `/tmp/opencode/opencode-jetbrains-host-source`.

This is a depth-one, blob-filtered, sparse source checkout. npm's SLSA publication statement links this commit to `@opencode/core@2.2.5`; the source manifests still say 2.2.4. Metadata and attestation are copied alongside this file; their cryptographic signatures were not independently verified.

## Files for parent reconciliation

`host-fix-validated.patch` supersedes the earlier extracted-harness `source-fix.patch`. It contains exactly:

- `packages/core/src/session/model-request.ts`: wraps the final native handler with the scoped fetch-options helper.
- `packages/core/src/session/model-http-options.ts`: preserves final redirect and combines hook/native abort signals, delegating to the inherited fetch. `Object.assign` preserves Bun's fetch static members and satisfies the actual Bun type surface (including `preconnect`).
- `packages/core/test/session-model-request-hooks.test.ts`: three actual Session middleware regressions using local Bun HTTP servers, covering 303, 307, and deadline/connection cancellation. Existing four tests are retained.
- `packages/core/test/session/model-http-options.test.ts`: six lower-level real-fetch regressions; now uses `bun:test`, Bun-compatible types, and preserves fake-fetch static members.

`plugin-smoke-fixture.patch` is a separate, optional integration fixture, not part of the proposed general upstream host fix. It adds `test/jetbrains-host-smoke.test.ts`. Supply `JETBRAINS_PLUGIN_MODULE=file:///absolute/path/to/dist/index.js`. It runs the real built plugin through OpenCode's native Promise adapter and host context, supplies fake connection credentials, and dispatches through actual Session middleware and FetchHttpClient. The inherited test fetch maps the fixed JetBrains URL to local Bun 303/307 fixtures; it never contacts JetBrains. It asserts fake Bearer auth, removal of x-api-key, redirect:error at final fetch, one attempted dispatch, and zero redirected target hits. No proxy/global-fetch replacement is used.

Neither patch changes plugin sources, README, installed OpenCode, or global configuration. No commit, push, or PR was created.

## Native runtime and dependency setup

- Runtime: ephemeral Bun 1.4.4 (`38afee6c8`), installed under `/tmp/opencode/jetbrains-bun-runtime`, as pinned by upstream root packageManager.
- Frozen filtered dependency install: `bun install --filter @opencode/core --frozen-lockfile --ignore-scripts`, cache under `/tmp/opencode/jetbrains-bun-cache`. First pass omitted optional dependencies; the second added the required native PTY package. No lifecycle scripts were enabled for the source workspace.
- Filtered installation omits root development dependency links. To run upstream typecheck/build without installing the rest of the monorepo, isolated root node_modules links expose already-installed Prettier, `@opencode/script`, the pinned native TypeScript 7.1.0-beta `tsc`, and `@types/mime-types@3.0.1` (installed separately under `/tmp/opencode/jetbrains-host-tools`). No source manifest/lock changes were needed.
- Sparse source and installed dependencies remained around one GB; no full monorepo installation was performed. Exact final footprint is in `source-size.txt`.
- All test/build commands use an empty environment with sandbox HOME `/tmp/opencode/jetbrains-host-home`, TMPDIR `/tmp/opencode`, and explicit runtime/compiler PATH. Upstream's test runner creates its own additional isolated HOME/XDG directories and in-memory database.

## Results

From `packages/core`, using the upstream `script/test.ts` runner:

```sh
bun run script/test.ts test/session-model-request-hooks.test.ts test/session/model-http-options.test.ts
```

**13 pass, 0 fail**, including the original four hooks tests, three source Session middleware regressions, and six helper tests. See `bun-integrated-tests-final.log`.

```sh
JETBRAINS_PLUGIN_MODULE=file:///var/home/leandromqrs/Projects/My/opencode-jetbrains-oauth/dist/index.js \
  bun run script/test.ts test/jetbrains-host-smoke.test.ts
```

**2 pass, 0 fail** with 14 assertions. See `bun-plugin-smoke-final.log`.

```sh
bun run typecheck:tsc
bun run build
```

Both upstream package scripts passed. Typechecking covers actual Core source and its tests, including the added fixtures; build emitted `packages/core/dist` through the official Core build script. See `core-typecheck-final.log` and `core-build.log`. Patch reverse-applicability and tracked diff whitespace checks also pass.

## Remaining boundary

This is native Bun source-host/session/plugin integration evidence plus a successful Core package build. It is not a rebuilt standalone CLI executable or a running full HTTP server. Those were not needed to exercise the affected bridge, and no unrelated CLI/TUI dependencies were installed. The installed OpenCode binary remains unchanged and therefore still requires a separately reviewed/rebuilt host before real inference. No real OAuth, JetBrains inference, user credential read, or global configuration mutation occurred. Credential persistence atomicity remains unverified and is outside this transport correction.
