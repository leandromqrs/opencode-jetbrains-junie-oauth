# Junie balance and quota panel

## Balance source

Junie queries `GET https://ingrazzio-cloud-prod.labs.jb.gg/auth/test` with the active connection's access token. The response may contain `active`, `balanceLeft`, `licenseType`, and `balanceUnit`. The plugin must not expose identity fields.

The installed Junie 3959.5 implementation divides credit values by **100,000**. Values with the `USD` unit are not divided. The plugin parser recognizes `CREDITS` (the unit observed in this account's authenticated query), `CREDIT`, `USD`, and the native fallback for a missing unit; unknown units remain unavailable until verified. The `GZL` license does not provide a displayable balance through this path; an inactive account or a `NONE` license does not represent a zero balance.

The endpoint does not report the contracted total, amount spent, renewal date, or reset. Therefore, the balance must not be converted into a percentage or used to invent a renewal forecast. The 19.89 credits in the supplied image are a historical observation, not a balance queried by the plugin.

## Optional bridge

The installed quota plugin has no public API for dynamic provider registration. Integration without modifying it uses a `remote-api` custom provider that reads a local endpoint returning `quota-v1`.

The bridge must listen only on `127.0.0.1`, accept only `GET /quota`, and authenticate with a key **separate** from the JetBrains token. The balance query may occur only after validating this key. No JetBrains token is returned to the consumer.

In this environment, the `junie-balance` custom definition is **enabled**, with provider `jetbrains`, URL `http://127.0.0.1:62365/quota`, format `quota-v1`, and `apiKeyEnv: "JUNIE_QUOTA_ADAPTER_KEY"`. Port 62365 is outside the OAuth callback range. Actual validation confirmed HTTP 401 without a key, HTTP 200 with the independent key, and a `Junie balance` entry in the quota plugin snapshot with `19.889935 credits` on 2026-11-06.

The format is a value entry with `resultType: "balance"`. Do not include a percentage, total limit, or reset. Unavailability must be distinguished from an actual zero balance.

## Configuration and environment

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

The legacy plugin option `quotaBridge: { port: 62365, apiKeyEnv: "JUNIE_QUOTA_ADAPTER_KEY" }` now describes an externally managed bridge; it does **not** create a listener. RPC status reports `management: "external"` and `running: null` rather than claiming reachability. Start and monitor the adapter separately. This removes competing port binds and prevents disposal of an arbitrary project from closing the panel's endpoint.

The bridge receives `requestTimeoutMs` (12 seconds by default) internally and limits requests, connections, and header size. It rejects methods other than GET, paths other than `/quota`, query strings, unexpected Host, browser Origin, and missing or invalid authentication before querying the balance. Shutdown releases connections and the port.

This agent's MCP `quota_provider_test` did not receive the service variable and reported a missing key. Integrated verification was performed by the OpenCode process itself, whose environment contains the key, using the panel's refresh RPC:

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
