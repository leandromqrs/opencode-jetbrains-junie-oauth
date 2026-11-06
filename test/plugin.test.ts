import { test } from "node:test"
import assert from "node:assert/strict"
import plugin, { parseOptions } from "../src/index.js"
import { Plugin, type Credential, type Provider, type Model } from "@opencode/plugin/effect"
import { Effect, Exit, Scope, Stream } from "effect"
import { memoryStorage } from "./discovery-support.js"
import { createDiscovery } from "../src/discovery.js"
import { TestClock } from "effect/testing"
import { createServer } from "node:net"

test("discovery needs no configured model; overrides reject unsafe limits and IDs", () => {
  assert.deepEqual(parseOptions({}).models, [])
  for (const options of [{ models: false }, { models: [{ id: "gpt-test", context: 100, output: 10 }] }, { models: [{ id: "claude-test", context: 10, output: 100 }] }, { models: [{ id: "claude-test", context: 100, output: 10 }], timeoutMs: 0 }]) {
    assert.throws(() => parseOptions(options))
  }
  assert.deepEqual(parseOptions({ quotaBridge: { port: 8787 } }).quotaBridge, { port: 8787, apiKeyEnv: "JUNIE_QUOTA_ADAPTER_KEY" })
  for (const quotaBridge of [true, [], { port: 0 }, { port: 65536 }, { port: 8787, apiKeyEnv: "token\n" }]) assert.throws(() => parseOptions({ quotaBridge }))
})

test("external quota bridge configuration never binds a location-owned listener; native quota stays active-account scoped", async () => {
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const port = (reservation.address() as { port: number }).port
  const originalFetch = globalThis.fetch
  const envName = "JUNIE_TEST_QUOTA_ADAPTER_KEY"
  const previousKey = process.env[envName]
  process.env[envName] = "separate-local-adapter-key-1234567890"
  let metadataCalls = 0
  let connected = true
  let handlers: Record<string, () => Effect.Effect<any>> = {}
  const registration = { dispose: Effect.void }
  const ctx = {
    storage: memoryStorage().storage,
    event: { subscribe: () => Stream.empty },
    options: { quotaBridge: { port, apiKeyEnv: envName } },
    rpc: { register: (_definition: unknown, value: typeof handlers) => Effect.sync(() => { handlers = value; return registration }) },
    provider: { transform: () => Effect.succeed(registration) },
    integration: {
      transform: () => Effect.succeed(registration),
      connection: {
        active: () => Effect.sync(() => connected ? { type: "credential", id: "one", method: "oauth", label: "private" } : undefined),
        resolve: () => Effect.succeed({ type: "oauth", access: "private-access" }),
      },
    },
    session: { hook: () => Effect.succeed(registration) },
  }
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://ingrazzio-cloud-prod.labs.jb.gg")) return originalFetch(input, init)
    metadataCalls++
    return Response.json({ active: true, licenseType: "AIP", balanceUnit: "CREDITS", balanceLeft: 1989000, username: "private" })
  }
  const scope = await Effect.runPromise(Scope.make())
  let url = ""
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(metadataCalls, 0)
    const status = await Effect.runPromise(handlers.status())
    assert.equal(status.quotaBridge.running, null)
    assert.equal(status.quotaBridge.management, "external")
    url = status.quotaBridge.url
    assert.equal(url, `http://127.0.0.1:${port}/quota`)
    assert.equal((await Effect.runPromise(handlers.quota())).amount, 19.89)
    assert.equal(metadataCalls, 1)
    connected = false
    assert.equal((await Effect.runPromise(handlers.quota())).state, "unavailable")
    assert.equal(metadataCalls, 1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env[envName]
    else process.env[envName] = previousKey
    await new Promise<void>(resolve => reservation.close(() => resolve()))
  }
})

test("external bridge status does not inspect the service key or claim reachability", async () => {
  const envName = "JUNIE_TEST_MISSING_ADAPTER_KEY"
  const previous = process.env[envName]
  delete process.env[envName]
  let handlers: Record<string, () => Effect.Effect<any>> = {}
  let oauthRegistered = false
  const registration = { dispose: Effect.void }
  const ctx = {
    storage: memoryStorage().storage,
    event: { subscribe: () => Stream.empty },
    options: { quotaBridge: { port: 8787, apiKeyEnv: envName } },
    rpc: { register: (_definition: unknown, value: typeof handlers) => Effect.sync(() => { handlers = value; return registration }) },
    provider: { transform: () => Effect.succeed(registration) },
    integration: {
      transform: () => Effect.sync(() => { oauthRegistered = true; return registration }),
      connection: { active: () => Effect.succeed(undefined) },
    },
    session: { hook: () => Effect.succeed(registration) },
  }
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* plugin.effect(ctx as unknown as Plugin.Context)
      assert.equal(oauthRegistered, true)
      const status = yield* handlers.status()
      assert.equal(status.quotaBridge.enabled, true)
       assert.equal(status.quotaBridge.running, null)
       assert.equal(status.quotaBridge.management, "external")
       assert.equal(status.quotaBridge.error, undefined)
       assert.equal(status.quotaBridge.url, "http://127.0.0.1:8787/quota")
    })))
  } finally {
    if (previous !== undefined) process.env[envName] = previous
  }
})

test("discovered public aliases bind dated wire requests and invalidate publication on account changes", async () => {
  const originalFetch = globalThis.fetch
  let handlers: Record<string, () => Effect.Effect<any>> = {}
  let inventory: any
  let transform: (editor: any) => void = () => {}
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
  let activeID = "one"
  const registration = { dispose: Effect.void, events: { emit: () => Effect.void } }
  const apply = () => transform({ add: (value: unknown) => { inventory = value } })
  const ctx = {
    storage: memoryStorage().storage,
    event: { subscribe: () => Stream.empty },
    options: {},
    rpc: { register: (_definition: unknown, value: typeof handlers) => Effect.sync(() => { handlers = value; return registration }) },
    provider: {
      transform: (callback: typeof transform) => Effect.sync(() => { transform = callback; apply(); return registration }),
      reload: () => Effect.sync(apply),
    },
    integration: {
      transform: () => Effect.succeed(registration),
      connection: {
        active: () => Effect.sync(() => ({ type: "credential", id: activeID, method: "oauth", label: "private" })),
        resolve: () => Effect.succeed({ type: "oauth", access: "fake-access" }),
      },
    },
    session: { hook: (name: string, callback: any) => Effect.sync(() => { hooks.set(name, callback); return registration }) },
  }
  globalThis.fetch = async (_input, init) => Response.json(new Headers(init?.headers).get("x-llm-model") === "google" ? { models: [] } : { data: [{ id: "gpt-5.4-2026-03-05" }] })
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
    assert.equal(inventory.models.length, 0)
    await Effect.runPromise(handlers.refresh())
    assert.equal(inventory.models.length, 1)
    assert.equal(inventory.models[0].id, "gpt-5.4")
    assert.equal(inventory.models[0].modelID, "gpt-5.4-2026-03-05")
    assert.equal(inventory.sourceConnection.id, "one")
    const event = () => ({ model: { id: "gpt-5.4" }, request: new Request("https://ingrazzio-cloud-prod.labs.jb.gg/v1/responses", { method: "POST", body: '{"model":"gpt-5.4-2026-03-05","input":[]}' }) })
    const allowed = event()
    await Effect.runPromise(hooks.get("http.request")!(allowed))
    assert.equal(allowed.request.headers.get("x-llm-model"), "openai")
    activeID = "two"
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!(event())), /route/)
    await Effect.runPromise(handlers.status())
    assert.equal(inventory.models.length, 0)
    activeID = "one"
    await Effect.runPromise(hooks.get("http.request")!(event()))
    assert.equal(inventory.models.length, 1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    globalThis.fetch = originalFetch
  }
})

test("V2 setup registers a native OAuth integration and provider-scoped hooks without I/O", async () => {
  let inventory: { info: Provider.Info; models: readonly Model.Info[] } | undefined
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
  let auth: any
  const integration = { id: "jetbrains-junie-oauth", name: "jetbrains-junie-oauth" }
  let credential: Credential.OAuth | undefined
  const ctx = {
    storage: memoryStorage().storage,
    event: { subscribe: () => Stream.empty },
    options: { models: [{ id: "claude-test", context: 100, output: 10, tools: true }] },
    rpc: { register: () => Effect.succeed({ dispose: Effect.void }) },
    provider: { transform: (fn: any) => Effect.sync(() => { fn({ add: (value: typeof inventory) => { inventory = value } }); return { dispose: Effect.void } }) },
    integration: {
      transform: (fn: any) => Effect.sync(() => {
        fn({ method: { update: (value: any) => { auth = value } }, update: (id: string, update: (value: typeof integration) => void) => { assert.equal(id, integration.id); update(integration) } })
        return { dispose: Effect.void }
      }),
      connection: { active: () => Effect.succeed(credential ? {} : undefined), resolve: () => Effect.succeed(credential) },
    },
    session: { hook: (name: string, fn: any, scope: any) => Effect.sync(() => { assert.equal(scope.providerID, "jetbrains"); hooks.set(name, fn); return { dispose: Effect.void } }) },
  }
  const scope = await Effect.runPromise(Scope.make())
  try {
  await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(scope)))
  assert.equal(inventory!.info.package, "@opencode/ai/providers/anthropic-compatible")
  assert.equal(inventory!.info.settings?.baseURL, "https://ingrazzio-cloud-prod.labs.jb.gg/v1")
  assert.equal(inventory!.info.integrationID, auth.integrationID)
  assert.equal(inventory!.models[0].capabilities.tools, true)
  assert.deepEqual(inventory!.models[0].capabilities.input, ["text"])
  assert.equal(auth.method.type, "oauth")
  assert.equal(integration.name, "JetBrains / Junie")
  assert.equal(auth.integrationID, "jetbrains-junie-oauth")
  assert.equal(typeof auth.authorize, "function")
  assert.equal(typeof auth.refresh, "function")
  const event = { request: new Request("https://ingrazzio-cloud-prod.labs.jb.gg/v1/messages", { method: "POST", headers: { "x-api-key": String(inventory!.info.settings?.apiKey) }, body: '{"model":"claude-test"}' }) }
  await assert.rejects(Effect.runPromise(hooks.get("http.request")!(event)), /Sign in/)
  credential = { type: "oauth", methodID: "pkce" as never, access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 300000 }
  await Effect.runPromise(hooks.get("http.request")!(event))
  assert.equal(event.request.headers.get("authorization"), "Bearer fake-access")
  assert.equal(event.request.headers.get("x-api-key"), null)
  const retry = { decision: { retry: true } }
  await Effect.runPromise(hooks.get("retry")!(retry))
  assert.deepEqual(retry.decision, { retry: false })
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("delivered RPC notifications synchronize active plugins and reload hydrates without HTTP", { timeout: 2000 }, async () => {
  const { storage } = memoryStorage()
  const listeners = new Set<(event: any) => void>()
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_input, init) => {
    requests++
    return Response.json(new Headers(init?.headers).get("x-llm-model") === "google" ? { models: [] } : { data: [{ id: "claude-sonnet-4-6" }] })
  }
  function location() {
    let handlers: Record<string, () => Effect.Effect<any>> = {}
    let transform: (editor: any) => void = () => {}
    let inventory: any
    let loaded!: () => void
    const published = new Promise<void>(resolve => { loaded = resolve })
    const apply = () => {
      transform({ add: (value: any) => { inventory = value } })
      if (inventory?.models.length) loaded()
    }
    const registration = { dispose: Effect.void, events: { emit: (name: string, payload: unknown) => Effect.sync(() => {
      assert.equal(name, "catalogUpdated")
      assert.deepEqual(payload, {})
      for (const listener of listeners) listener({ type: "rpc.jetbrains-junie.catalogUpdated", data: {} })
    }) } }
    const ctx = {
      options: {}, storage,
      event: { subscribe: (input: { types: string[] }) => {
        assert.deepEqual(input.types, ["rpc.jetbrains-junie.catalogUpdated", "integration.updated"])
        return Stream.fromEffect(Effect.promise(() => new Promise(resolve => { listeners.add(resolve) })))
      } },
      rpc: { register: (_definition: unknown, value: typeof handlers) => Effect.sync(() => { handlers = value; return registration }) },
      provider: { transform: (callback: typeof transform) => Effect.sync(() => { transform = callback; apply(); return registration }), reload: () => Effect.sync(apply) },
      integration: { transform: () => Effect.succeed(registration), connection: {
        active: () => Effect.succeed({ type: "credential", id: "one", method: "oauth", label: "private" }),
        resolve: () => Effect.succeed({ type: "oauth", access: "private-token" }),
      } },
      session: { hook: () => Effect.succeed(registration) },
    }
    return { ctx, published, handlers: () => handlers, inventory: () => inventory }
  }
  const scopes = await Promise.all([1, 2, 3].map(() => Effect.runPromise(Scope.make())))
  try {
    const first = location()
    const second = location()
    await Effect.runPromise(plugin.effect(first.ctx as unknown as Plugin.Context).pipe(Scope.provide(scopes[0])))
    await Effect.runPromise(plugin.effect(second.ctx as unknown as Plugin.Context).pipe(Scope.provide(scopes[1])))
    assert.equal(requests, 0)
    await Effect.runPromise(first.handlers().refresh())
    await second.published
    assert.equal(second.inventory().models.length, 1)
    assert.equal(second.inventory().sourceConnection.id, "one")
    assert.equal(requests, 4)
    await Effect.runPromise(Scope.close(scopes[0], Exit.void))
    globalThis.fetch = async () => { assert.fail("reload must not issue HTTP") }
    const reloaded = location()
    await Effect.runPromise(plugin.effect(reloaded.ctx as unknown as Plugin.Context).pipe(Scope.provide(scopes[2])))
    await reloaded.published
    assert.equal(reloaded.inventory().models.length, 1)
    assert.equal(reloaded.inventory().sourceConnection.id, "one")
    assert.equal(requests, 4)
  } finally {
    for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void))
    globalThis.fetch = original
  }
})

test("active locations converge by local KV lifecycle rechecks when RPC events are location filtered", { timeout: 2000 }, async () => {
  const shared = memoryStorage()
  let reads = 0
  let reloads = 0
  const storage = { ...shared.storage, get: (key: string) => shared.storage.get(key).pipe(Effect.tap(() => Effect.sync(() => { reads++ }))) }
  let inventory: any
  let transform: (editor: any) => void = () => {}
  const apply = () => transform({ add: (value: any) => { inventory = value } })
  const registration = { dispose: Effect.void }
  const ctx = {
    options: {}, storage,
    event: { subscribe: () => Stream.never },
    rpc: { register: () => Effect.succeed(registration) },
    provider: { transform: (callback: typeof transform) => Effect.sync(() => { transform = callback; apply(); return registration }), reload: () => Effect.sync(() => { reloads++; apply() }) },
    integration: { transform: () => Effect.succeed(registration), connection: {
      active: () => Effect.succeed({ type: "credential", id: "one", method: "oauth", label: "private" }),
      resolve: () => Effect.succeed({ type: "oauth", access: "private-token" }),
    } },
    session: { hook: () => Effect.succeed(registration) },
  } as unknown as Plugin.Context
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return Response.json({ data: [{ id: "claude-sonnet-4-6" }] }) }
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pluginScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(pluginScope, Exit.void))
      yield* plugin.effect(ctx).pipe(Scope.provide(pluginScope))
      yield* TestClock.adjust("15 seconds")
      assert.equal(inventory.models.length, 0)
      assert.equal(requests, 0)
      const elsewhere = createDiscovery(ctx, () => Effect.void)
      yield* elsewhere.refresh
      assert.equal(requests, 4)
      assert.equal(inventory.models.length, 0)
      globalThis.fetch = async () => { assert.fail("lifecycle rechecks must not issue HTTP") }
      yield* TestClock.adjust("15 seconds")
      assert.equal(inventory.models.length, 1)
      assert.equal(inventory.sourceConnection.id, "one")
      assert.equal(requests, 4)
      assert.equal(reloads, 1)
      const synchronizedReads = reads
      yield* TestClock.adjust("45 seconds")
      assert.ok(reads > synchronizedReads)
      assert.equal(reloads, 1)
      yield* Scope.close(pluginScope, Exit.void)
      const disposedReads = reads
      yield* TestClock.adjust("60 seconds")
      assert.equal(reads, disposedReads)
      assert.equal(reloads, 1)
    })).pipe(Effect.provide(TestClock.layer())))
  } finally { globalThis.fetch = original }
})

for (const closingScope of ["attempt", "plugin"]) {
test(`closing the ${closingScope} scope closes the OAuth callback listener despite deferred native readiness`, { timeout: 2000 }, async () => {
  let auth: any
  const registration = { dispose: Effect.void }
  const ctx = {
    storage: memoryStorage().storage,
    event: { subscribe: () => Stream.empty },
    options: { models: [{ id: "claude-test", context: 100, output: 10 }] },
    rpc: { register: () => Effect.succeed({ dispose: Effect.void }) },
    provider: { transform: () => Effect.succeed(registration) },
    integration: { connection: { active: () => Effect.never }, transform: (fn: any) => Effect.sync(() => {
      fn({ method: { update: (value: any) => { auth = value } }, update: () => {} })
      return registration
    }) },
    session: { hook: () => Effect.succeed(registration) },
  }
  const pluginScope = await Effect.runPromise(Scope.make())
  const attemptScope = await Effect.runPromise(Scope.make())
  let pluginClosed = false
  let authorization: any
  try {
    await Effect.runPromise(Effect.addFinalizer(() => Effect.sync(() => { pluginClosed = true })).pipe(Scope.provide(pluginScope)))
    await Effect.runPromise(plugin.effect(ctx as unknown as Plugin.Context).pipe(Scope.provide(pluginScope)))
    authorization = await Effect.runPromise(auth.authorize({}).pipe(Scope.provide(attemptScope)))
    const redirect = new URL(new URL(authorization.url).searchParams.get("redirect_uri")!)
    const probe = () => fetch(`http://127.0.0.1:${redirect.port}/invalid-probe`, { signal: AbortSignal.timeout(1000) })
    const before = await probe()
    assert.equal(before.status, 400)
    await before.body?.cancel()
    await Effect.runPromise(Scope.close(closingScope === "attempt" ? attemptScope : pluginScope, Exit.void))
    await assert.rejects(probe())
    await assert.rejects(Effect.runPromise(authorization.callback), /cancelled/)
    assert.equal(pluginClosed, closingScope === "plugin")
  } finally {
    await Effect.runPromise(Scope.close(attemptScope, Exit.void))
    await Effect.runPromise(Scope.close(pluginScope, Exit.void))
  }
})
}
