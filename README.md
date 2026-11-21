# Junie by Jetbrains for OpenCode

An unofficial OpenCode V2 plugin for signing in to Junie, discovering the models listed for your JetBrains account, and reading your remaining credits. The plugin is not affiliated with JetBrains.

[Quick start](#quick-start) · [Balance panel](#balance-panel) · [Development](#development)

> [!WARNING]
> Do not enable real inference on the uncorrected OpenCode 2.2.5 host: it drops plugin redirect and cancellation safeguards. Read the [transport blocker](docs/host-transport-blocker.md). Successful login, discovery, or balance queries do not establish inference entitlement or transport safety.

## Quick start

Requires Node.js 22+, npm, OpenCode 2.2.5 (the tested version), and a JetBrains account. The browser must reach the machine running the OpenCode service.

1. Clone and build the plugin:

   ```sh
   git clone https://github.com/leandromqrs/opencode-jetbrains-junie-oauth.git
   cd opencode-jetbrains-junie-oauth
   npm ci --ignore-scripts
   npm run build
   ```

2. Add this entry to `plugins` in your project or global `opencode.jsonc`, preserving existing entries and replacing the path:

   ```json
   {
     "plugins": [
       { "package": "/absolute/path/to/opencode-jetbrains-junie-oauth" }
     ]
   }
   ```

3. Sign in from a location that loads the plugin:

   ```sh
   opencode auth login jetbrains-junie-oauth --method pkce
   ```

   Open the displayed URL. The loopback callback uses ports 62345–62364 and expires after five minutes. An existing Junie CLI login is not imported.

4. Refresh the catalog explicitly, replacing the project path:

   ```sh
   opencode api post '/api/rpc/jetbrains-junie/refresh?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
   ```

   Models appear as `jetbrains/<model-id>`. Startup restores matching cached metadata without an upstream query; signing in alone does not fetch models. Eco is unsupported.

## Balance panel

To check your balance without a panel, run the quota RPC using the same project path:

```sh
opencode api post '/api/rpc/jetbrains-junie/quota?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
```

To display it in OpenCode Quota, enable the [plugin-managed bridge](docs/quota.md#automatic-plugin-managed-bridge). It runs inside OpenCode and uses a separate loopback key; it does not require the legacy standalone adapter. Junie reports a remaining balance, not a total allowance or a reset time. An unavailable balance is not zero.

## Development

```sh
npm run typecheck
npm test
npm run test:quota-adapter
npm run build
```

[Architecture](ARCHITECTURE.md) · [Model inventory](docs/account-catalog.md) · [Configuration examples](examples)
