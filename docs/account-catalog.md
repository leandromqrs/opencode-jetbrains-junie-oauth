# Observed authenticated catalog

Metadata query performed on 2026-11-06 with the active JetBrains connection, without inference. All four routes returned HTTP 200: Anthropic 14 IDs, OpenAI 33, Google 9, and Grok 4. Of the 60 IDs advertised by the gateway, 36 match the integrated Junie catalog: 11 Claude, 13 GPT, 8 Gemini, and 4 Grok.

The listing is authenticated; it does not prove inference authorization for each model. The effort levels below come from Junie 3959.5's bundled metadata, reconciled with the IDs listed by the account, not from a paid test or a remote effort endpoint. Eco is not implemented. Account pricing remains unknown.

## Claude

- `claude-sonnet-4-6`, `claude-opus-4-6`: low, medium, high, max.
- `claude-haiku-5-5`: low, medium, high, xhigh.
- `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`: low, medium, high, xhigh, max.

## GPT

- `gpt-5-2025-08-07`: minimal, low, medium, high.
- `gpt-5.2-2025-12-11`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`: low, medium, high, xhigh.
- `gpt-6-astra`, `gpt-6.1-sol`: low, medium, high, xhigh, max.
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-sol`, `gpt-6.1-terra`, `gpt-6-luna`: none, low, medium, high, xhigh, max.

## Gemini

- `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemini-4-argon`: low, medium, high.
- `gemini-3.1-flash-lite`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`: minimal, low, medium, high.

## Grok

- `grok-4.3`, `grok-4.5`: low, medium, high.
- `grok-4.6`, `grok-4.7`: low, medium, high, xhigh.

## Refresh

The sanitized inventory is persisted through OpenCode's global plugin storage, scoped to the connection, routing, and schema. Reloads and other locations restore the matching snapshot without startup HTTP requests. Events trigger local rechecks; a scoped 15-second local-storage check synchronizes other active locations without relying on cross-location event delivery. Status reports snapshot age and marks it stale after 24 hours. The `jetbrains-junie` RPC exposes `refresh`, `catalog`, `status`, and `quota`. The catalog distinguishes raw advertised IDs from reconciled models and reports the provenance of capabilities, limits, and effort levels. Switching connections or logging out prevents publication of results for the previous account.
