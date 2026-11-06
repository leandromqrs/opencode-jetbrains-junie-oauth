# OpenCode JetBrains Junie OAuth

Use your JetBrains login to discover Junie models and check your credit balance in OpenCode V2.

[Getting started](#getting-started) · [Model discovery](#model-discovery) · [Credit balance](#credit-balance) · [Security](#security-and-limitations) · [Documentation](#documentation)

> [!CAUTION]
> **Real inference is not cleared for use on OpenCode 2.2.5.** Its HTTP hook handling drops the redirect policy and cancellation signal set by this plugin. A host patch has been tested but has **not** replaced the installed executable. Do not send model prompts until the host correction is applied and verified. [Read the transport diagnosis](docs/host-transport-blocker.md).

> [!IMPORTANT]
> This is an experimental, unofficial integration, not a JetBrains product. Authenticated model listings and credit balance queries have been verified; inference entitlement, credit consumption, and billing have not. Review the [JetBrains AI terms](https://www.jetbrains.com/legal/docs/terms/jetbrains-ai-service/) before use.

## Features

- **JetBrains OAuth:** authorization code flow with PKCE, state validation, a loopback callback, and native OpenCode credential storage and refresh.
- **Account-scoped discovery:** manually fetch model listings using only the active JetBrains connection. Results are invalidated when the selected connection changes.
- **Native model protocols:** Anthropic Messages for Claude, Responses for GPT and Grok, and Google generateContent for Gemini, with model-specific effort variants.
- **Official balance metadata:** read remaining Junie credits without estimating spending, allocation, or renewal dates.
- **Optional quota panel bridge:** expose balance-only `quota-v1` data through an authenticated loopback endpoint, using a key separate from JetBrains credentials.

## Getting started

### Requirements

- OpenCode **2.2.5**, the version currently tested.
- Node.js **22 or later**, with npm.
- A JetBrains account and a browser that can reach the machine running the OpenCode service.

### Install locally

From this checkout:

```sh
npm ci
npm run build
```

Add the plugin to your global or project `opencode.jsonc`, preserving existing settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-jetbrains-junie-oauth",
      "options": {
        "timeoutMs": 120000
      }
    }
  ]
}
```

Use your actual checkout path. No predefined model entries are needed. OpenCode reloads configuration after changes; the plugin does not edit it automatically. See the [discovery example](examples/discovery.json).

### Sign in

Run in a directory whose configuration loads the plugin:

```sh
opencode auth login jetbrains-junie-oauth --method pkce
```

Open the authorization URL displayed by OpenCode and complete the JetBrains login. The callback listens only on loopback, trying ports **62345–62364**, and expires after five minutes. Listeners close on completion, cancellation, timeout, or plugin disposal.

The integration ID is `jetbrains-junie-oauth`; the model provider ID is `jetbrains`. Neither changes when the package is renamed. An existing Junie CLI login does not automatically sign in this plugin, and signing in does not invoke a model or fetch the catalog.

## Model discovery

Refresh explicitly after signing in:

```sh
opencode api post /api/rpc/jetbrains-junie/refresh --data '{"input":{}}'
```

Inspect status and the complete catalog:

```sh
opencode api post /api/rpc/jetbrains-junie/status --data '{"input":{}}'
opencode api post /api/rpc/jetbrains-junie/catalog --data '{"input":{}}'
```

Use an explicit project location when invoking the native API; the installed CLI may otherwise target the home directory rather than the shell's working directory. For example:

```sh
opencode api post '/api/rpc/jetbrains-junie/refresh?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
```

Sanitized catalog metadata is stored in OpenCode's global, plugin-namespaced storage, scoped to the connection, routing, and schema. Locations restore the matching inventory without resolving credentials or making startup HTTP requests. Events trigger local rechecks; other active locations converge through a 15-second local-storage check, without upstream HTTP requests. Status reports cache freshness; models are marked stale after 24 hours, not silently rediscovered. Published models use `jetbrains/<model-id>`.

The authenticated metadata check on **2026-11-06** returned HTTP 200 for all four families:

| Family | Gateway-listed IDs | Integrated models | Native protocol |
| --- | ---: | ---: | --- |
| Claude | 14 | 11 | Anthropic Messages |
| GPT | 33 | 13 | Responses |
| Gemini | 9 | 8 | generateContent |
| Grok | 4 | 4 | Responses |
| **Total** | **60** | **36** | |

OpenCode published those **36 models with 159 effort variants**. See the [model and effort inventory](docs/account-catalog.md) for the full list.

> [!NOTE]
> Gateway listings are authenticated metadata, not proof that every listed model is authorized for inference. Effort mappings come from the installed Junie **3959.5** catalog reconciled with those listings. Limits use account-listed metadata where present, then embedded metadata; unknown limits and account prices are not invented. **Eco is not supported:** it is Junie orchestration, not another effort value.

## Credit balance

Query the active account directly:

```sh
opencode api post /api/rpc/jetbrains-junie/quota --data '{"input":{}}'
```

The plugin reads the Junie `/auth/test` metadata endpoint. The observed `CREDITS` unit is divided by **100,000**; `USD` remains unscaled. Missing or invalid balances remain unavailable rather than becoming zero. The endpoint provides no allocation, spending, or reset date, so none is inferred.

### Optional quota panel integration

The installed quota plugin supports custom remote providers but cannot directly register this plugin's OAuth connection. The optional bridge keeps JetBrains credentials inside this plugin and returns only balance data.

1. Generate a separate random adapter key and store it outside the repository. The index accepts 32–256 printable, non-space ASCII characters.
2. Supply it as `JUNIE_QUOTA_ADAPTER_KEY` in the **OpenCode service process environment**. An export in another terminal does not update a running service.
3. Build the project and start the standalone adapter with an explicit target project:

   ```sh
   bash scripts/quota-adapter.sh start --location /absolute/path/to/project
   bash scripts/quota-adapter.sh status
   ```

   The Linux wrapper reads the existing private key file at `~/.config/opencode/jetbrains-junie/quota-adapter.key` and starts a transient user service. It survives terminal closure and project/plugin reloads, but is not installed for automatic startup after reboot. Use `stop` to shut it down. Use `--port` and `--key-file` to override defaults. For foreground use, replace `start` with `run`.

4. The following legacy plugin option may describe the external adapter URL in status; it **does not start a listener**:

   ```json
   {
     "quotaBridge": {
       "port": 62365,
       "apiKeyEnv": "JUNIE_QUOTA_ADAPTER_KEY"
     }
   }
   ```

5. Register a custom remote provider in the quota plugin with URL `http://127.0.0.1:62365/quota`, format `quota-v1`, provider ID `jetbrains`, and the same `apiKeyEnv`. Validate the bridge before enabling it.

The adapter is a separate process, not owned by any project plugin scope. It discovers the native service on each authenticated request and forwards only the balance RPC for the configured location, without caching balances or exporting JetBrains credentials. It binds only to `127.0.0.1`, requires its own Bearer key, and rejects unexpected paths, methods, Host headers, and browser origins before reading the balance.

In the validated local setup, `junie-balance` is enabled and the quota plugin's own refresh RPC returned **approximately 19.89 credits** on 2026-11-06. This is a historical observation, not a fixed balance. See the [quota guide](docs/quota.md) for setup details, the Linux service helper, and end-to-end validation. The [bridge example](examples/quota-bridge.json) uses port 8787; keep the bridge and provider URLs consistent if choosing another port.

## Security and limitations

- Credentials remain in OpenCode's native integration storage. The plugin does not read Junie CLI token files or maintain its own OAuth token store. Storage protection and cross-process refresh coordination remain host responsibilities.
- Discovery and balance queries use bounded, fixed-origin HTTPS GETs with redirects blocked. No catalog or balance request runs automatically during plugin activation.
- Model requests rebuild authentication headers for the approved gateway and strip foreign driver credentials. **The installed host still requires the transport correction described above.**
- Native drivers handle streaming and tools without an SSE translation layer. Declared input/output support is text only; images and audio are not advertised.
- HTTP error bodies are sanitized. Errors inside otherwise successful streams are left to the native driver and are not sanitized by this plugin.
- Automatic retries are disabled. There is no fallback to another license, account, or endpoint. Forced license selection, CLI token import, manual authorization-code entry, and Grazie v9 are unsupported.
- The default request timeout is 120 seconds, configurable from 1 to 600 seconds. Request bodies are limited to 8 MiB. The host's signal handling limitation also affects the plugin's inference timeout.
- The last dependency installation reported **24 moderate npm audit findings**, not yet triaged. No automatic dependency fixes were applied.

## Development and verification

```sh
npm test
npm run typecheck
npm run build
```

The latest full run passed **77 plugin tests and 5 launcher tests**, type checking, and the build. Tests cover OAuth lifecycle, durable catalog restoration, cross-location convergence without event delivery, polling disposal, account-switch races, native driver streaming and effort mappings, credit normalization, and standalone adapter authentication and recovery. They use synthetic credentials and mocked inference responses. Run launcher checks with `node --test scripts/quota-adapter.test.mjs`.

Live checks separately verified OAuth login, authenticated catalog metadata, native model publication, balance retrieval, bridge authorization, and the quota plugin's balance snapshot. **No paid inference was performed.**

The separate host patch passed 13 focused Core tests, two plugin integration tests, Core type checking, and the Core build against official source. These results do not replace validation of the installed executable. See the [host patch report](docs/host-fix/validated/VALIDATION.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `Integration not found` | Confirm the plugin entry is in the configuration loaded by the current project. Cloning alone does not register it. |
| `Location plugins did not finish activating` | Inspect activation logs and allow startup to finish; do not repeatedly restart the service. |
| No discovered models after reload | Check the explicit location, active connection, and cache status. Refresh once if that connection has no stored catalog. |
| Models appear in one project but not another | Confirm the RPC location explicitly. In the installed CLI, the default RPC location can be the home directory rather than the shell's working directory. |
| Bridge reports a missing key | Check the adapter's private key file and the quota consumer's service environment, not just your terminal. |
| Balance is unavailable | Check the active login and quota RPC; do not interpret unavailable as zero. |
| Standalone quota test cannot find the key | It may run outside the service environment. Validate through the quota plugin's RPC in the configured service. |

An explicit project location uses the native deep-object query syntax:

```sh
opencode api post '/api/rpc/jetbrains-junie/status?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
```

An old balance alongside `Can't reach…` means the quota panel retained its last successful observation while the latest refresh failed. It does not, by itself, indicate an expired JetBrains login. Check `bash scripts/quota-adapter.sh status`. The adapter must be started separately after reboot; restarting or reloading a project should not close it.

## Removal

Run `opencode auth logout` and select this integration's account before removing the plugin entry. Remove any default `jetbrains/...` model selection. If the quota bridge is configured, disable or remove its custom quota provider too. Removing the plugin does not delete credentials stored by OpenCode.

## Documentation

- [Account-listed models and effort variants](docs/account-catalog.md)
- [Catalog provenance and protocol mappings](docs/catalog-provenance.md)
- [Credit balance and quota bridge](docs/quota.md)
- [Host transport blocker](docs/host-transport-blocker.md)
- [Validated host patch and evidence](docs/host-fix/validated/VALIDATION.md)
- [OpenCode V2 plugin documentation](https://opencode.ai/v2/docs/build/plugins)

Protocol research used the installed Junie **26.11.3 / 3959.5** implementation without opening credential files. The plugin identifies itself in agent headers rather than impersonating Junie. The [junie-api reference at revision c56c86a](https://github.com/fabienfleureau/junie-api/tree/c56c86a406ac0d6003458d2979ae81d3e73eeac5) is unofficial and is not proof of current compatibility.
