# OpenCode JetBrains Junie OAuth

Unofficial JetBrains OAuth plugin for OpenCode, with account-scoped Claude, GPT, Gemini, and Grok discovery and an optional Junie balance panel.

> [!WARNING]
> Do not enable real inference on the uncorrected OpenCode 2.2.5 host: it drops plugin redirect and cancellation safeguards. Read the [transport blocker](docs/host-transport-blocker.md). Successful login, discovery, or balance queries do not establish inference entitlement or transport safety.

## Quick start

Requires Node.js 22+, npm, OpenCode 2.2.5 (the tested version), and a JetBrains account. The browser must reach the machine running the OpenCode service.

1. Build this checkout:

   ```sh
   npm ci
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

5. Read the active account balance using the same project path:

   ```sh
   opencode api post '/api/rpc/jetbrains-junie/quota?location[directory]=/absolute/path/to/project' --data '{"input":{}}'
   ```

   For a panel, follow the optional [quota adapter setup](docs/quota.md). It uses a separate private key and process; the Linux helper must be started again after reboot. An unavailable balance is not zero.

[Architecture](ARCHITECTURE.md) · [Development](CONTRIBUTING.md) · [Agent guidance](AGENTS.md) · [Model inventory](docs/account-catalog.md) · [Configuration examples](examples)
