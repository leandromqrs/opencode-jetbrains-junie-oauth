import { Rpc, type Plugin } from "@opencode/plugin/effect"
import { Effect, Semaphore, type Schema } from "effect"
import { createHash } from "node:crypto"
import { discoverCatalog, vendors, type Catalog } from "./catalog.js"
import { reconcileCatalog, type AccountModel } from "./inventory.js"
import { advertisedModels, METADATA_SOURCE } from "./static-catalog.js"
import { getJunieBalance, type JunieBalance } from "./quota.js"
import { ACCOUNT_ROUTING_HEADERS } from "./transport.js"

export const CATALOG_CHANGED_EVENT = "rpc.jetbrains-junie.catalogUpdated"
const CACHE_VERSION = 1
const ROUTING = JSON.stringify(ACCOUNT_ROUTING_HEADERS)
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

export const catalogRPC = Rpc.define({
  id: "jetbrains-junie",
  methods: {
    refresh: { input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "object", additionalProperties: true } },
    status: { input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "object", additionalProperties: true } },
    catalog: { input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "object", additionalProperties: true } },
    quota: { input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "object", additionalProperties: true } },
  },
  events: { catalogUpdated: { schema: { type: "object", properties: {}, additionalProperties: false } } },
})
export type ActiveConnection = Parameters<Plugin.Context["integration"]["connection"]["resolve"]>[0]
export const connectionKey = (connection: ActiveConnection | undefined) => connection?.type === "credential" ? `credential:${connection.id}` : connection?.type === "env" ? `env:${connection.name}` : undefined

export function catalogStorageKey(connection: ActiveConnection): string {
  return `catalog:v${CACHE_VERSION}:${digest(`${ROUTING}:${connectionKey(connection)}`)}`
}

function snapshot(connection: ActiveConnection, catalog: Catalog) {
  return { version: CACHE_VERSION, routing: ROUTING, metadataSource: METADATA_SOURCE, connectionID: connection.type === "credential" ? connection.id : undefined, catalog }
}

function restore(value: unknown, connection: ActiveConnection): Catalog | undefined {
  const record = object(value)
  if (!record || connection.type !== "credential" || connection.method !== "oauth" || record.version !== CACHE_VERSION || record.routing !== ROUTING || record.metadataSource !== METADATA_SOURCE || record.connectionID !== connection.id) return undefined
  const saved = object(record.catalog)
  if (!saved || !integer(saved.fetchedAt) || saved.fetchedAt > Date.now() + 60_000 || !Array.isArray(saved.routes) || saved.routes.length !== vendors.length) return undefined
  const routes: Catalog["routes"] = []
  for (const vendor of vendors) {
    const matches = saved.routes.filter(value => object(value)?.vendor === vendor)
    if (matches.length !== 1) return undefined
    const route = object(matches[0])!
    if (!Array.isArray(route.models) || route.models.length > 2000 || (route.status !== undefined && (!Number.isInteger(route.status) || Number(route.status) < 100 || Number(route.status) > 599))) return undefined
    const models: Catalog["routes"][number]["models"] = []
    const ids = new Set<string>()
    for (const value of route.models) {
      const item = object(value)
      if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}$/.test(item.id) || ids.has(item.id) || (item.context !== undefined && !integer(item.context)) || (item.output !== undefined && !integer(item.output))) return undefined
      ids.add(item.id)
      models.push({ id: item.id, ...(item.context !== undefined ? { context: item.context as number } : {}), ...(item.output !== undefined ? { output: item.output as number } : {}) })
    }
    routes.push({ vendor, ...(route.status !== undefined ? { status: route.status as number } : {}), ...(route.error !== undefined ? { error: "Metadata request failed or returned an unsupported listing." } : {}), models })
  }
  return { fetchedAt: saved.fetchedAt, routes }
}

export function createDiscovery(ctx: Plugin.Context, publish: (models: AccountModel[], connection: ActiveConnection) => Effect.Effect<void>, notify: () => Effect.Effect<void> = () => Effect.void) {
  let cached: { connection: ActiveConnection; catalog: Catalog; models: AccountModel[] } | undefined
  let refreshing = false
  let storageState: "available" | "invalid" | "unavailable" = "available"
  const lock = Semaphore.makeUnsafe(1)
  const active = Effect.suspend(() => ctx.integration.connection.active("jetbrains-junie-oauth"))
  const clear = Effect.gen(function* () {
    if (!cached) return
    const previous = cached.connection
    cached = undefined
    yield* publish([], previous)
  })
  const current = lock.withPermit(Effect.gen(function* () {
    const connection = yield* active
    if (cached && connectionKey(cached.connection) !== connectionKey(connection)) yield* clear
    if (!connection || connection.type !== "credential" || connection.method !== "oauth") return connection
    storageState = "available"
    const loaded = yield* ctx.storage.get(catalogStorageKey(connection)).pipe(Effect.map(value => ({ ok: true as const, value })), Effect.catchDefect(() => Effect.succeed({ ok: false as const, value: undefined })))
    if (connectionKey(connection) !== connectionKey(yield* active)) {
      yield* clear
      return undefined
    }
    if (!loaded.ok) { storageState = "unavailable"; return connection }
    const value = loaded.value
    const catalog = value === undefined ? undefined : restore(value, connection)
    storageState = value !== undefined && !catalog ? "invalid" : "available"
    if (!catalog) {
      yield* clear
      return connection
    }
    if (!cached || JSON.stringify(cached.catalog) !== JSON.stringify(catalog)) {
      const models = reconcileCatalog(catalog)
      const source = { type: "credential" as const, id: connection.id, method: "oauth" as const, label: "JetBrains connection" }
      cached = { connection: source, catalog, models }
      yield* publish(models, source)
    }
    return connection
  }))
  const status = Effect.gen(function* () {
    const connection = yield* current
    const ageMs = cached ? Math.max(0, Date.now() - cached.catalog.fetchedAt) : null
    return { connected: !!connection, refreshedAt: cached?.catalog.fetchedAt ?? null, supportedModels: cached?.models.length ?? 0, refreshing, entitlement: "unverified", eco: "unsupported", cache: "native storage; account/routing/schema scoped", storage: storageState, freshness: ageMs === null ? "missing" : ageMs > STALE_AFTER_MS ? "stale" : "fresh", ageMs, routing: "EAP disabled; no forced license" }
  })
  const catalog = Effect.gen(function* () {
    yield* current
    return { metadataSource: METADATA_SOURCE, effortSource: METADATA_SOURCE, limitSource: "Account-listed limits when present; embedded Junie limits otherwise; unknown output limits remain null.", capabilitySource: "Native text/tool driver support; not an account inference entitlement check.", advertised: advertisedModels, accountListed: cached?.catalog ?? null, supported: cached?.models ?? [], entitlement: "unverified", pricing: "unknown", eco: "unsupported" }
  })
  const refresh = Effect.gen(function* () {
    if (refreshing) return { error: "JetBrains discovery is already running." }
    refreshing = true
    return yield* Effect.gen(function* () {
      const connection = yield* current
      if (!connection) return { error: "Sign in to jetbrains-junie-oauth before refreshing." }
      const credential = yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!credential || credential.type !== "oauth") return { error: "JetBrains OAuth credentials unavailable; sign in again." }
      if (connectionKey(connection) !== connectionKey(yield* current)) return { error: "Active JetBrains connection changed; refresh again." }
      const result = yield* Effect.tryPromise({ try: signal => discoverCatalog(credential.access, fetch, signal), catch: () => new Error("JetBrains discovery cancelled or failed.") }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!result) return { error: "JetBrains discovery cancelled or failed." }
      if (connectionKey(connection) !== connectionKey(yield* current)) return { error: "Active JetBrains connection changed; refresh again." }
      const committed = yield* lock.withPermit(Effect.gen(function* () {
        if (connection.type !== "credential" || connection.method !== "oauth" || connectionKey(connection) !== connectionKey(yield* active)) return false
        const catalog = restore(snapshot(connection, result), connection)
        if (!catalog) return false
        const saved = yield* ctx.storage.set(catalogStorageKey(connection), snapshot(connection, catalog) as unknown as Schema.Json).pipe(
          Effect.as(true), Effect.catchDefect(() => Effect.sync(() => { storageState = "unavailable"; return false })),
        )
        return saved && connectionKey(connection) === connectionKey(yield* active)
      }))
      if (!committed) return { error: "JetBrains catalog could not be saved or the active connection changed; refresh again." }
      yield* current
      yield* notify()
      return yield* catalog
    }).pipe(Effect.ensuring(Effect.sync(() => { refreshing = false })))
  })
  const balance = Effect.gen(function* () {
    const unavailable = (reason: "invalid-credentials" | "invalid-context"): JunieBalance => ({ state: "unavailable", reason, observedAt: new Date().toISOString() })
    const connection = yield* current
    if (!connection) return unavailable("invalid-credentials")
    const credential = yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!credential || credential.type !== "oauth") return unavailable("invalid-credentials")
    if (connectionKey(connection) !== connectionKey(yield* current)) return unavailable("invalid-context")
    const result = yield* Effect.promise(signal => getJunieBalance(credential.access, { signal, routingHeaders: ACCOUNT_ROUTING_HEADERS }))
    if (connectionKey(connection) !== connectionKey(yield* current)) return unavailable("invalid-context")
    return result
  })
  return { refresh, status, catalog, balance, synchronize: current.pipe(Effect.asVoid), bindings: (connection: ActiveConnection) => cached && connectionKey(cached.connection) === connectionKey(connection) ? cached.models : [] }
}
