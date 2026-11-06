import { test } from "node:test"
import assert from "node:assert/strict"
import { discoverCatalog, parseListing } from "../src/catalog.js"
import { reconcileCatalog, nativeModel } from "../src/inventory.js"
import { createDiscovery } from "../src/discovery.js"
import { Effect } from "effect"
import type { Plugin, Connection } from "@opencode/plugin/effect"
import { memoryStorage } from "./discovery-support.js"

test("catalog parsers retain only model metadata and normalize Google names", () => {
  assert.deepEqual(parseListing("google", { models: [{ name: "models/gemini-test", displayName: "private name", inputTokenLimit: 100, outputTokenLimit: 10 }], account: "private" }), [{ id: "gemini-test", context: 100, output: 10 }])
  assert.deepEqual(parseListing("anthropic", { data: [{ id: "claude-test", secret: "private" }] }), [{ id: "claude-test" }])
  assert.throws(() => parseListing("openai", { error: "secret" }), /format/)
})

test("only account-listed known models are published with native semantics and no invented prices or limits", () => {
  const models = reconcileCatalog({ fetchedAt: 1, routes: [
    { vendor: "openai", status: 200, models: [{ id: "gpt-5.4-2026-03-05" }, { id: "text-embedding-3-small" }] },
    { vendor: "google", status: 200, models: [{ id: "gemini-3.7-flash", context: 1048576, output: 65536 }] },
    { vendor: "anthropic", status: 403, models: [] },
  ] })
  assert.equal(models.length, 2)
  const gpt = nativeModel(models.find(m => m.vendor === "openai")!)
  assert.equal(gpt.modelID, "gpt-5.4-2026-03-05")
  assert.equal(gpt.package, "@opencode/ai/providers/openai")
  assert.equal(gpt.limit.output, 0)
  assert.deepEqual(gpt.cost, [])
  assert.deepEqual(gpt.variants[0].settings, { reasoningEffort: "low" })
  const gemini = nativeModel(models.find(m => m.vendor === "google")!)
  assert.equal(gemini.limit.output, 65536)
  assert.deepEqual(gemini.settings?.thinkingConfig, { thinkingLevel: "medium", includeThoughts: true })
})

test("discovery resolves only the active JetBrains connection, never at startup, and discards a switched account", async () => {
  const original = globalThis.fetch
  let active: Connection.Info | undefined = { type: "credential", id: "one" as never, method: "oauth", label: "not emitted" }
  const resolutions: Connection.Info[] = []
  const published: unknown[] = []
  const controller = createDiscovery({ storage: memoryStorage().storage, integration: { connection: {
    active: (id: string) => { assert.equal(id, "jetbrains-junie-oauth"); return Effect.succeed(active) },
    resolve: (connection: Connection.Info) => { resolutions.push(connection); return Effect.succeed({ type: "oauth", access: "fake", methodID: "pkce" }) },
  } } } as unknown as Plugin.Context, (models, connection) => Effect.sync(() => { published.push({ models, connection }) }))
  assert.equal(resolutions.length, 0)
  globalThis.fetch = async () => Response.json({ data: [{ id: "claude-sonnet-4-6" }], models: [] })
  try {
    const result = await Effect.runPromise(controller.refresh)
    assert.ok(result && "supported" in result)
    assert.equal(resolutions.length, 1)
    assert.equal(published.length, 1)
    assert.equal((await Effect.runPromise(controller.status)).supportedModels, 1)
    active = { ...active!, id: "two" as never } as Connection.Info
    assert.equal((await Effect.runPromise(controller.status)).supportedModels, 0)
    assert.equal(controller.bindings(active).length, 0)
    assert.equal(published.length, 2)
    assert.deepEqual((published[1] as { models: unknown[] }).models, [])
    assert.doesNotMatch(JSON.stringify(await Effect.runPromise(controller.catalog)), /not emitted|fake/)
    active = undefined
    await Effect.runPromise(controller.refresh)
    assert.equal(resolutions.length, 1)
  } finally { globalThis.fetch = original }
})

test("ambiguous dated aliases fail closed; an exact listing takes precedence", () => {
  const catalog = { fetchedAt: 1, routes: [{ vendor: "openai" as const, status: 200, models: [{ id: "gpt-5.4-2026-03-05" }, { id: "gpt-5.4-2026-03-06" }] }] }
  assert.deepEqual(reconcileCatalog(catalog), [])
  catalog.routes[0].models.push({ id: "gpt-5.4" })
  assert.equal(reconcileCatalog(catalog)[0].wireID, "gpt-5.4")
})

test("oversized and malformed metadata are sanitized and cancellation stops subsequent routes", async () => {
  const malformed = await discoverCatalog("secret", async () => new Response("private-invalid-json"))
  assert.ok(malformed.routes.every(route => route.error && route.models.length === 0))
  const oversized = await discoverCatalog("secret", async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))
  assert.ok(oversized.routes.every(route => route.error && route.models.length === 0))
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(discoverCatalog("secret", async () => {
    calls++
    controller.abort()
    return Response.json({ data: [] })
  }, controller.signal), /cancelled/)
  assert.equal(calls, 1)
})

test("account changes during a refresh discard all fetched inventory", async () => {
  const original = globalThis.fetch
  let active = { type: "credential" as const, id: "one", method: "oauth" as const, label: "private" }
  let publications = 0
  const controller = createDiscovery({ storage: memoryStorage().storage, integration: { connection: {
    active: () => Effect.sync(() => active),
    resolve: () => Effect.succeed({ type: "oauth", access: "secret" }),
  } } } as unknown as Plugin.Context, () => Effect.sync(() => { publications++ }))
  globalThis.fetch = async () => {
    active = { ...active, id: "two" }
    return Response.json({ data: [{ id: "claude-sonnet-4-6" }], models: [] })
  }
  try {
    assert.match(JSON.stringify(await Effect.runPromise(controller.refresh)), /connection changed/)
    assert.equal(publications, 0)
    assert.equal((await Effect.runPromise(controller.status)).supportedModels, 0)
  } finally { globalThis.fetch = original }
})

test("quota is fetched on demand without caching and never returns a switched account balance", async () => {
  const original = globalThis.fetch
  let active: Connection.Info | undefined = { type: "credential", id: "one" as never, method: "oauth", label: "private" }
  let calls = 0
  let switchDuringFetch = false
  const controller = createDiscovery({ storage: memoryStorage().storage, integration: { connection: {
    active: () => Effect.sync(() => active),
    resolve: () => Effect.succeed({ type: "oauth", access: "fake" }),
  } } } as unknown as Plugin.Context, () => Effect.void)
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), "https://ingrazzio-cloud-prod.labs.jb.gg/auth/test")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake")
    assert.equal(new Headers(init?.headers).get("x-accept-eap-license"), "false")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.method, "GET")
    if (switchDuringFetch) active = { ...active!, id: "two" as never } as Connection.Info
    return Response.json({ active: true, balanceLeft: 1989000, balanceUnit: "CREDITS", licenseType: "AIP", username: "private" })
  }
  try {
    assert.equal(calls, 0)
    assert.equal((await Effect.runPromise(controller.balance)).state, "available")
    assert.equal((await Effect.runPromise(controller.balance)).state, "available")
    assert.equal(calls, 2)
    switchDuringFetch = true
    const switched = await Effect.runPromise(controller.balance)
    assert.deepEqual({ ...switched, observedAt: "time" }, { state: "unavailable", reason: "invalid-context", observedAt: "time" })
    assert.doesNotMatch(JSON.stringify(switched), /1989000|19.89|private|fake/)
    active = undefined
    assert.equal((await Effect.runPromise(controller.balance)).state, "unavailable")
    assert.equal(calls, 3)
  } finally { globalThis.fetch = original }
})

test("quota refuses a connection switch while resolving credentials before making any GET", async () => {
  const original = globalThis.fetch
  let active = { type: "credential" as const, id: "one", method: "oauth" as const, label: "private" }
  const controller = createDiscovery({ storage: memoryStorage().storage, integration: { connection: {
    active: () => Effect.sync(() => active),
    resolve: () => Effect.sync(() => { active = { ...active, id: "two" }; return { type: "oauth", access: "fake" } }),
  } } } as unknown as Plugin.Context, () => Effect.void)
  globalThis.fetch = async () => { assert.fail("quota must not fetch after the account changed") }
  try {
    const balance = await Effect.runPromise(controller.balance)
    assert.equal(balance.state, "unavailable")
    if (balance.state === "unavailable") assert.equal(balance.reason, "invalid-context")
  } finally { globalThis.fetch = original }
})

test("discovery is GET-only, fixed-origin, redirect-blocked and sanitizes failures", async () => {
  const requests: Request[] = []
  const catalog = await discoverCatalog("secret", async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.headers.get("x-llm-model") === "anthropic") return Response.json({ data: [{ id: "claude-sonnet-4-6" }] })
    return new Response("private service failure", { status: 403 })
  })
  assert.equal(requests.length, 4)
  for (const request of requests) {
    assert.equal(request.method, "GET")
    assert.equal(new URL(request.url).origin, "https://ingrazzio-cloud-prod.labs.jb.gg")
    assert.equal(request.redirect, "error")
    assert.equal(request.headers.get("authorization"), "Bearer secret")
    assert.equal(request.headers.get("x-accept-eap-license"), "false")
  }
  assert.equal(catalog.routes[0].status, 200)
  assert.equal(catalog.routes[1].status, 403)
  assert.doesNotMatch(JSON.stringify(catalog), /secret|private/)
})
