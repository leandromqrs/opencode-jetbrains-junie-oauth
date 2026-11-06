import { Integration, Model, Plugin, Provider } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { beginLogin, METHOD_ID, singleFlightRefresh, type Login } from "./oauth.js"
import { prepareRequest, sanitizeResponse, UPSTREAM } from "./transport.js"
import { CATALOG_CHANGED_EVENT, catalogRPC, connectionKey, createDiscovery, type ActiveConnection } from "./discovery.js"
import { nativeModel, type AccountModel } from "./inventory.js"

export const PROVIDER_ID = Provider.ID.make("jetbrains")
export const INTEGRATION_ID = Integration.ID.make("jetbrains-junie-oauth")
const refresh = singleFlightRefresh()

export interface ConfiguredModel {
  id: string
  name: string
  context: number
  output: number
  tools: boolean
}

export interface QuotaBridgeConfig { port: number; apiKeyEnv: string }

export function parseOptions(options: Record<string, unknown>): { models: ConfiguredModel[]; timeoutMs: number; quotaBridge?: QuotaBridgeConfig } {
  if (options.models !== undefined && (!Array.isArray(options.models) || options.models.length > 50)) {
    throw new Error("JetBrains models override must be an array with at most 50 entries.")
  }
  const ids = new Set<string>()
  const models = ((options.models ?? []) as unknown[]).map((value: unknown): ConfiguredModel => {
    if (!value || typeof value !== "object") throw new Error("Invalid JetBrains model configuration.")
    const model = value as Record<string, unknown>
    if (typeof model.id !== "string" || !/^claude-[a-zA-Z0-9._-]{1,120}$/.test(model.id) || ids.has(model.id)
      || !Number.isSafeInteger(model.context) || Number(model.context) < 1
      || !Number.isSafeInteger(model.output) || Number(model.output) < 1 || Number(model.output) > Number(model.context)
      || (model.tools !== undefined && typeof model.tools !== "boolean")
      || (model.name !== undefined && (typeof model.name !== "string" || model.name.length > 200))) {
      throw new Error("JetBrains models require unique claude-* IDs and positive context/output limits; output must not exceed context.")
    }
    ids.add(model.id)
    return { id: model.id, name: typeof model.name === "string" ? model.name : model.id, context: Number(model.context), output: Number(model.output), tools: model.tools === true }
  })
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 600_000) throw new Error("JetBrains timeoutMs must be between 1000 and 600000.")
  let quotaBridge: QuotaBridgeConfig | undefined
  if (options.quotaBridge !== undefined && options.quotaBridge !== false) {
    const config = options.quotaBridge
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("JetBrains quotaBridge requires a port and optional apiKeyEnv.")
    const { port, apiKeyEnv = "JUNIE_QUOTA_ADAPTER_KEY" } = config as Record<string, unknown>
    if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535 || typeof apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error("JetBrains quotaBridge requires port 1–65535 and a valid apiKeyEnv name.")
    quotaBridge = { port: Number(port), apiKeyEnv }
  }
  return { models, timeoutMs: Number(timeoutMs), ...(quotaBridge ? { quotaBridge } : {}) }
}

export default Plugin.define({
  id: "opencode-jetbrains-junie-oauth",
  effect: ctx => Effect.gen(function* () {
    const options = parseOptions(ctx.options)
    let discovered: { models: AccountModel[]; connection: ActiveConnection } | undefined
    let notify: () => Effect.Effect<void> = () => Effect.void
    const discovery = createDiscovery(ctx, (models, connection) => Effect.gen(function* () {
      discovered = { models, connection }
      yield* ctx.provider.reload()
    }), () => notify())
    const bridgeStatus = { enabled: !!options.quotaBridge, management: "external", running: null, ...(options.quotaBridge ? { url: `http://127.0.0.1:${options.quotaBridge.port}/quota` } : {}) }
    const logins = new Set<Login>()
    yield* Effect.addFinalizer(() => Effect.sync(() => { for (const login of logins) login.cancel(); logins.clear() }))
    yield* ctx.provider.transform(editor => {
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID),
          name: "JetBrains / Junie (unofficial)", activation: "enabled", integrationID: INTEGRATION_ID,
          package: "@opencode/ai/providers/anthropic-compatible",
          // The driver requires a key before HTTP hooks; the scoped hook strips this non-secret placeholder.
          settings: { baseURL: `${UPSTREAM}/v1`, apiKey: "oauth-hook-placeholder", timeout: options.timeoutMs, encoding: "none", transport: "http" },
        },
        ...(discovered ? { sourceConnection: discovered.connection } : {}),
        models: discovered ? discovered.models.map(nativeModel) : options.models.map(model => ({
          ...Model.Info.default(PROVIDER_ID, Model.ID.make(model.id)),
          name: model.name, capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
          limit: { context: model.context, output: model.output },
        })),
      })
    })
    const registration = yield* ctx.rpc.register(catalogRPC, {
      refresh: () => discovery.refresh,
      status: () => discovery.status.pipe(Effect.map(status => ({ ...status, quotaBridge: bridgeStatus }))),
      catalog: () => discovery.catalog,
      quota: () => discovery.balance,
    }).pipe(Effect.orDie)
    notify = () => registration.events.emit("catalogUpdated", {}).pipe(Effect.catch(() => Effect.void))
    yield* ctx.integration.transform(editor => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Sign in with JetBrains (unofficial PKCE)" },
        authorize: () => Effect.gen(function* () {
          const login = yield* Effect.acquireRelease(
            Effect.tryPromise({ try: () => beginLogin(), catch: error => error }).pipe(
              Effect.tap(login => Effect.sync(() => { logins.add(login) })),
            ),
            login => Effect.sync(() => { logins.delete(login); login.cancel() }),
          )
          return { mode: "auto" as const, url: login.url, expiresAt: login.expiresAt, instructions: "Open this URL in a browser on this machine. Subscription usage and terms are unverified. No model request is made during login.", callback: Effect.tryPromise({ try: () => login.callback, catch: error => error }) }
        }),
        refresh: credential => Effect.tryPromise({ try: () => refresh(credential), catch: error => error }),
      })
      editor.update(INTEGRATION_ID, integration => {
        integration.name = "JetBrains / Junie"
      })
    })
    yield* ctx.session.hook("http.request", event => Effect.gen(function* () {
      yield* discovery.synchronize
      const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) throw new Error("Sign in to the JetBrains / Junie integration before using this provider.")
      const credential = yield* ctx.integration.connection.resolve(connection).pipe(
        Effect.catch(() => Effect.die(new Error("JetBrains credentials could not be resolved; sign in again."))),
      )
      if (!credential || credential.type !== "oauth") throw new Error("JetBrains OAuth credentials are unavailable; sign in again.")
      if (connectionKey(connection) !== connectionKey(yield* ctx.integration.connection.active(INTEGRATION_ID))) throw new Error("Active JetBrains connection changed; select the model again.")
      const bindings = discovered ? discovery.bindings(connection).filter(model => model.id === event.model.id) : options.models.filter(model => !event.model || model.id === event.model.id).map(model => model.id)
      event.request = yield* Effect.promise(() => prepareRequest(event.request, credential.access, bindings, options.timeoutMs))
    }), { providerID: PROVIDER_ID })
    yield* ctx.session.hook("http.response", event => Effect.gen(function* () {
      event.response = yield* Effect.promise(() => sanitizeResponse(event.response))
    }), { providerID: PROVIDER_ID })
    yield* ctx.session.hook("retry", event => Effect.sync(() => { event.decision = { retry: false } }), { providerID: PROVIDER_ID })
    yield* ctx.event.subscribe({ types: [CATALOG_CHANGED_EVENT, "integration.updated"] }).pipe(
      Stream.runForEach(() => discovery.synchronize), Effect.catch(() => Effect.void), Effect.forkScoped,
    )
    yield* discovery.synchronize.pipe(Effect.andThen(Effect.sleep("15 seconds")), Effect.forever, Effect.forkScoped)
  }),
})
