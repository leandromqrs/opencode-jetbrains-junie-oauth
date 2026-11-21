# Junie balance and quota panel

## Balance source

Junie queries `GET https://ingrazzio-cloud-prod.labs.jb.gg/auth/test` with the active connection's access token. The response may contain `active`, `balanceLeft`, `licenseType`, and `balanceUnit`. The plugin must not expose identity fields.

The installed Junie 3959.5 implementation divides credit values by **100,000**. Values with the `USD` unit are not divided. The plugin parser recognizes `CREDITS` (the unit observed in this account's authenticated query), `CREDIT`, `USD`, and the native fallback for a missing unit; unknown units remain unavailable until verified. The `GZL` license does not provide a displayable balance through this path; an inactive account or a `NONE` license does not represent a zero balance.

The endpoint does not report the contracted total, amount spent, renewal date, or reset. Therefore, the balance must not be converted into a percentage or used to invent a renewal forecast. The 19.89 credits in the supplied image are a historical observation, not a balance queried by the plugin.

## Experimental native quota RPC

Set `"quotaRpc": true` in the Junie plugin entry's `options` to register `jetbrains.quota/status` in that OpenCode location. The ID uses the OpenCode provider ID (`jetbrains`), not the OAuth integration ID. This is opt-in and does not configure the HTTP bridge, replace `jetbrains-junie/quota`, or require a separate process or bearer key.

From a location that loads the plugin, replace the project path and probe the RPC:

```sh
opencode api post '/api/rpc/jetbrains.quota/status?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
```

The output follows the [`<providerID>.quota` convention](https://github.com/WuJunkai2004/opencode-glm-vistatus/blob/main/docs/quota-rpc.md). Example with a synthetic balance:

```json
{
  "label": "Junie by Jetbrains",
  "groups": [{ "title": "Balance", "value": "19.89 credits" }]
}
```

Consumers must support `value` rows. A zero balance is a value row; a missing connection, failed read, or account change during a read yields `groups: []`. Consumers should clear previously displayed values on an empty result, failed call, or location change. Each call reads the current account via the existing balance reader; the pilot does not poll or cache balances itself.

In a build of OpenCode Quota that includes the Junie native reader, the `jetbrains.balance` row appears under **Junie by Jetbrains**. It reports credits or USD, without a usage percentage or reset time. Verify the native row on the OpenCode installation you actually use before removing the Junie custom provider or its bridge; older builds still need the bridge.

## Optional bridge

The installed quota plugin has no public API for dynamic provider registration. Integration without modifying it uses a `remote-api` custom provider that reads a local endpoint returning `quota-v1`.

The bridge must listen only on `127.0.0.1`, accept only `GET /quota`, and authenticate with a key **separate** from the JetBrains token. The balance query may occur only after validating this key. No JetBrains token is returned to the consumer.

In this environment, the `junie-balance` custom definition is **enabled**, with provider `jetbrains`, URL `http://127.0.0.1:62365/quota`, format `quota-v1`, and `apiKeyEnv: "JUNIE_QUOTA_BRIDGE_KEY"`. Port 62365 is outside the OAuth callback range. The earlier standalone setup used `JUNIE_QUOTA_ADAPTER_KEY` and returned `19.889935 credits` on 2026-11-06; the automatic setup below uses an independently generated bridge key instead.

The format is a value entry with `resultType: "balance"`. Do not include a percentage, total limit, or reset. Unavailability must be distinguished from an actual zero balance.

## Configuration and environment

### Automatic plugin-managed bridge

Opt in through the Junie plugin's options:

```json
{
  "quotaBridge": {
    "port": 62365,
    "apiKeyEnv": "JUNIE_QUOTA_BRIDGE_KEY",
    "autoKey": true,
    "shared": true
  }
}
```

Keep the existing custom provider URL `http://127.0.0.1:62365/quota`, provider ID, `remote-api` mode, `quota-v1` format, and enabled flag. Its `apiKeyEnv` must match `JUNIE_QUOTA_BRIDGE_KEY`. No quota-consumer source change is required. Do not export a separate value for this dedicated variable: the Junie plugin publishes the account-bound bearer in its process environment after listener setup. A conflicting inherited value is preserved and reported as `incompatible-config`, not overwritten.

The shared root key is generated independently of OAuth and the old adapter at `~/.local/state/opencode-jetbrains-junie-oauth/quota-bridge-v1/bridge.key`. The directory must remain `0700`, and the key must be a `0600` regular file owned by the user. State must be outside participating project paths, including their canonical targets. Never copy the root key into a project, print it, configure it as a Junie OAuth token, or commit it. No old key file is read or migrated.

The listener starts with the plugin, without requesting balance metadata. Authenticated panel refreshes use the existing active-account quota reader. Multiple locations share a process-owned listener; unloading one does not stop the others. Multiple processes authenticate a compatible owner with a nonce/HMAC health protocol and recover the port after the owner exits. After a reboot, opening OpenCode with this plugin enabled recreates the listener and environment key from private state. No manual adapter command, systemd unit, or external daemon is needed.

Status reports `management: "plugin"` and `running: true` only for an attached listener. It is not a claim that upstream balance retrieval is healthy. Sanitized diagnostics include `missing-account`, `ambiguous-account`, `incompatible-config`, and `start-failed`. Different active connection identities derive different transport bearers and cannot silently attach to each other's owner. Conflicting local leases or account changes fail closed. Balance reads recheck local identities before and after retrieval; shared followers detect their own changes during periodic local monitoring. Account-change synchronization across processes is not instantaneous. Close old managed locations and reload after an account switch, or after signing in when startup reported `missing-account`.

`autoKey: true` without `shared: true` uses an ephemeral, account-bound key and process-local leases. Use shared mode for fixed-port multi-process and reboot recovery. Omitting `autoKey` preserves the external-adapter behavior below. Do not run a legacy adapter on the same port as a managed bridge; an unrecognized listener causes `start-failed` without receiving the bearer or being stopped.

### Legacy standalone adapter

The quota plugin's remote provider uses an environment variable specified by `apiKeyEnv` in the **OpenCode service process**. The standalone adapter reads the matching key from a protected file. Exporting a variable in another terminal does not change the environment of an already running service.

Do not put the key or JetBrains credentials in the repository. Do not enable the custom provider before configuring and validating the bridge. Preserve the existing global configuration and other providers.

In this environment, an independent key has already been generated outside the repository, with permission `600`, at `~/.config/opencode/jetbrains-junie/quota-adapter.key`. Do not recreate it on each startup. The adapter wrapper verifies a regular file owned by the current user with mode `400` or `600`, rejects symlinks, and does not print the key or place its value in process arguments.

```sh
bash scripts/quota-adapter.sh start --location /var/home/leandromqrs/Projects/LuminusOS
bash scripts/quota-adapter.sh status
bash scripts/quota-adapter.sh stop
```

The Linux wrapper uses a transient user systemd service. It survives terminal closure and location/plugin reloads, but is not automatically started after reboot. Start it again after reboot. `run` is available for foreground use; `--port` and `--key-file` override defaults. The compatibility wrapper `scripts/service-with-quota.sh` now forwards these adapter commands; it no longer starts or restarts the native OpenCode service.

## Implementation status

The balance module is implemented in `src/quota.ts`; the hardened listener is in `src/quota-bridge.ts`. The standalone `src/quota-adapter.ts` discovers the native service through the supported client API for every authenticated request and invokes only the public `jetbrains-junie/quota` RPC for the explicitly configured location. It does not cache balances or receive JetBrains tokens. Native service replacement is discovered on subsequent requests.

The legacy plugin option `quotaBridge: { port: 62365, apiKeyEnv: "JUNIE_QUOTA_ADAPTER_KEY" }` describes an externally managed bridge when `autoKey` is absent; it does **not** create a listener. RPC status reports `management: "external"` and `running: null` rather than claiming reachability. Start and monitor this legacy adapter separately, or opt into the automatic mode above.

The bridge receives `requestTimeoutMs` (12 seconds by default) internally and limits requests, connections, and header size. It rejects methods other than GET, paths other than `/quota`, query strings, unexpected Host, browser Origin, and missing or invalid authentication before querying the balance. Shutdown releases connections and the port.

During the earlier standalone setup, the MCP `quota_provider_test` did not receive the service variable and reported a missing key. Integrated verification was performed by the OpenCode process itself, whose environment contained the key, using the panel's refresh RPC:

```sh
opencode api post /api/rpc/slkiser.opencode-quota/refresh --data '{"input":{"reason":"manual","providerIds":["quota-providers"]}}'
```

The snapshot returned an entry with authority `provider_reported`, type `balance`, label `Junie balance`, and account `Junie`, without passing on the JetBrains token.

The standalone migration was validated against the explicit LuminusOS location: the adapter returned HTTP 200, kept the same process across a project reload, and the quota plugin refresh returned `19.889935 credits` with no provider error. LuminusOS and the home location both published 36 models and 159 variants from the shared catalog; LuminusOS restored them after reload without another catalog refresh. Integration metadata now displays `JetBrains / Junie` while retaining ID `jetbrains-junie-oauth`. Immediately during a location reload, native endpoints may temporarily return not-ready errors; this is distinct from the adapter losing its listener.

## Repair after a service restart

On 2026-11-06, the panel's “Custom providers / Not set up” state was traced to a missing `JUNIE_QUOTA_ADAPTER_KEY` in the OpenCode server environment. The standalone adapter was also stopped. Native Junie OAuth and balance retrieval remained healthy.

Restarting with an environment variable on just the repair process was insufficient: another running client won the service-start race with its old environment. OpenCode 2.2.5 supports a private global `service.json` environment map, loaded by each CLI client's service configuration. Persisting the existing adapter key there, preserving unrelated settings, and restarting the service resolved the race without changing the OAuth login or rotating the adapter key. Never put the key in shell arguments, logs, this repository or shared documentation.

Validation through the actual `quota-providers` collector returned `Junie balance`, type `balance`, with **11.956759 credits** and no provider error. The service environment now survives native restarts, but the adapter remains a transient unit and must still be started after a reboot.

Real inference use remains subject to the OpenCode 2.2.5 transport blocker described in [host-transport-blocker.md](host-transport-blocker.md). Querying the balance through a direct, protected fetch is a metadata operation, not a model call or an installation of the host patch.

## Automatic bridge activation (2026-11-12)

After explicit user approval, the Junie plugin options were updated to `autoKey: true`, `shared: true` and `apiKeyEnv: "JUNIE_QUOTA_BRIDGE_KEY"`, retaining port 62365. The existing Custom-provider definition was updated through the consumer's supported API and explicitly re-enabled using its request fingerprint. No quota-consumer source, OAuth credential, inference driver or host service was changed. The old adapter key was not read or migrated.

The full Junie suite passed 91 tests; typecheck, standalone-adapter checks, build and diff checking also passed. Multi-process regressions cover concurrent startup, owner-exit takeover and account isolation, including revocation of an inherited matching bearer after a follower changes accounts. Conflicting inherited values remain untouched. These tests use synthetic accounts and private temporary state.

Following activation, native status reported a plugin-managed running bridge. A targeted panel refresh returned the `Junie balance` row, and the standard `quota_provider_test` returned `12.305867 credits`. Missing and incorrect bearer requests returned HTTP 401; a browser-origin request returned HTTP 403. After another authorized location reload, My and LuminusOS both reported a running bridge, and the standard provider test returned the same balance again. This establishes live retrieval and reload recovery; a full operating-system reboot has not yet been observed after activation.
