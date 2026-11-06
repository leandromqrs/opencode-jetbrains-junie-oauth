# Junie catalog and effort levels

## Sources and limits

The Junie selector image identifies the need for multiple families and effort levels; it is not a source of API IDs, limits, or authorization. The name displayed in the selector may differ from the name sent to the service.

In the installed CLI 3959.5, `junie list-models` returns 37 bundled entries. This describes the catalog distributed with the program, not availability for an individual subscription. Bytecode inspection and local execution of metadata functions did not perform inference.

The bundled catalog can provide IDs, limits, and reference prices. These values do not prove contracted pricing, balance, quota, eligibility, or current availability. Null limits must not become invented numbers; a missing price does not mean zero cost.

An authenticated remote listing also does not equal a successful inference call: the service may advertise models that require a license or additional limits. The implementation must distinguish these forms of evidence.

## Observed protocols

- Claude: Anthropic Messages, with effort in the `output_config.effort` field; thinking configuration is separate.
- GPT and Grok: Responses, with `reasoning.effort`. Grok provider selection in the gateway uses `grok`, not `xai`.
- Gemini: Google's generateContent, with `generationConfig.thinkingConfig.thinkingLevel`. The Google Interactions protocol is a separate route, not a synonym.

When registering variants in OpenCode, the semantic names of driver options must produce these fields in the final protocol. Simply adding models to the old Anthropic transport does not implement support for the other families.

## Eco

Eco is neither a reasoning level nor a `service_tier`. Junie's implementation ties Eco to model/effort eligibility, an implementation model, and a remote `ECO_MODE_IMPLEMENTATION` flag. Reproducing this orchestration requires a separate contract; it must not be advertised as supported merely because the selector displays it.

## Discovery security

Query metadata only through an explicit action, with the active JetBrains connection. Do not export credentials, open Junie token files, or use credentials from other integrations. Requests must use a fixed HTTPS origin, GET, blocked redirects, and bounded deadlines and sizes; errors and artifacts must not include tokens or personal data. The cache and inventory must track the selected account.

The inference transport blocker in OpenCode 2.2.5 remains independent of metadata discovery. Querying the catalog does not install the host correction or validate subscription consumption.
