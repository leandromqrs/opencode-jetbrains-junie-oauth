import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { catalogStorageKey, createDiscovery, type ActiveConnection } from "../src/discovery.js"
import { memoryStorage } from "./discovery-support.js"

const connection = (id: string): ActiveConnection => ({ type: "credential", id: id as never, method: "oauth", label: "private-account-label" })

function context(storage: Plugin.Context["storage"], active: () => ActiveConnection | undefined, resolve = () => Effect.succeed({ type: "oauth", access: "private-token" })) {
  return { storage, integration: { connection: { active: () => Effect.sync(active), resolve } } } as unknown as Plugin.Context
}

async function seed(storage: Plugin.Context["storage"], active = connection("one")) {
  const original = globalThis.fetch
  globalThis.fetch = async (_input, init) => Response.json(new Headers(init?.headers).get("x-llm-model") === "google" ? { models: [] } : { data: [{ id: "claude-sonnet-4-6" }] })
  try {
    const controller = createDiscovery(context(storage, () => active), () => Effect.void)
    await Effect.runPromise(controller.refresh)
  } finally { globalThis.fetch = original }
}

test("durable reload restores account-bound inventory using local KV only", async () => {
  const { storage, values } = memoryStorage()
  const active = connection("one")
  await seed(storage, active)
  const serialized = JSON.stringify([...values])
  assert.doesNotMatch(serialized, /private-token|private-account-label|Authorization|Bearer|username/)
  assert.ok(values.has(catalogStorageKey(active)))
  const publications: { models: unknown[]; connection: ActiveConnection }[] = []
  const restored = createDiscovery(context(storage, () => active, () => { assert.fail("startup must not resolve credentials") }), (models, source) => Effect.sync(() => { publications.push({ models, connection: source }) }))
  const original = globalThis.fetch
  globalThis.fetch = async () => { assert.fail("rehydration must not perform HTTP") }
  try {
    await Effect.runPromise(restored.synchronize)
    assert.equal(publications.length, 1)
    assert.equal(publications[0].models.length, 1)
    assert.equal(publications[0].connection.type, "credential")
    assert.equal(publications[0].connection.label, "JetBrains connection")
    assert.equal((await Effect.runPromise(restored.status)).supportedModels, 1)
    assert.equal(publications.length, 1)
  } finally { globalThis.fetch = original }
})

test("already-active locations converge through a metadata-only notification and shared KV", async () => {
  const { storage } = memoryStorage()
  let otherModels = 0
  const other = createDiscovery(context(storage, () => connection("one")), models => Effect.sync(() => { otherModels = models.length }))
  await Effect.runPromise(other.synchronize)
  assert.equal(otherModels, 0)
  let notifications = 0
  const first = createDiscovery(context(storage, () => connection("one")), () => Effect.void, () => Effect.gen(function* () { notifications++; yield* other.synchronize }))
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_input, init) => {
    requests++
    return Response.json(new Headers(init?.headers).get("x-llm-model") === "google" ? { models: [] } : { data: [{ id: "claude-sonnet-4-6" }] })
  }
  try {
    await Effect.runPromise(first.refresh)
    assert.equal(notifications, 1)
    assert.equal(otherModels, 1)
    assert.equal(requests, 4)
    assert.equal((await Effect.runPromise(other.status)).supportedModels, 1)
    assert.equal(requests, 4)
  } finally { globalThis.fetch = original }
})

test("switch and logout invalidate local inventory without leaking another account snapshot", async () => {
  const { storage, values } = memoryStorage()
  await seed(storage)
  let active: ActiveConnection | undefined = connection("one")
  const publications: number[] = []
  const controller = createDiscovery(context(storage, () => active), models => Effect.sync(() => { publications.push(models.length) }))
  assert.equal((await Effect.runPromise(controller.status)).supportedModels, 1)
  active = connection("two")
  assert.equal((await Effect.runPromise(controller.status)).supportedModels, 0)
  assert.equal(controller.bindings(active).length, 0)
  values.set(catalogStorageKey(active), structuredClone(values.get(catalogStorageKey(connection("one")))!))
  assert.equal((await Effect.runPromise(controller.status)).storage, "invalid")
  assert.equal(controller.bindings(active).length, 0)
  active = connection("one")
  assert.equal((await Effect.runPromise(controller.status)).supportedModels, 1)
  active = undefined
  assert.equal((await Effect.runPromise(controller.status)).supportedModels, 0)
  assert.deepEqual(publications, [1, 0, 1, 0])
})

test("hostile stored metadata is rejected or projected without routes, secrets, or settings", async () => {
  const { storage, values } = memoryStorage()
  const active = connection("one")
  await seed(storage, active)
  const key = catalogStorageKey(active)
  const saved = values.get(key) as any
  for (const patch of [
    { version: 0 }, { routing: "forced-license" }, { connectionID: "two" },
    { catalog: { ...saved.catalog, fetchedAt: Date.now() + 120000 } },
    { catalog: { fetchedAt: 1, routes: [] } },
    { catalog: { ...saved.catalog, routes: saved.catalog.routes.map((route: any) => ({ ...route, models: [{ id: "../../private" }] })) } },
  ]) {
    values.set(key, { ...saved, ...patch })
    const controller = createDiscovery(context(storage, () => active), () => Effect.void)
    const status = await Effect.runPromise(controller.status)
    assert.equal(status.storage, "invalid")
    assert.equal(status.supportedModels, 0)
  }
  const hostile = structuredClone(saved)
  hostile.access = "private-token"
  hostile.catalog.routes[0].models[0].settings = { baseURL: "https://evil.invalid", apiKey: "private-token" }
  values.set(key, hostile)
  const controller = createDiscovery(context(storage, () => active), () => Effect.void)
  const catalog = await Effect.runPromise(controller.catalog)
  assert.equal(catalog.supported.length, 1)
  assert.doesNotMatch(JSON.stringify(catalog), /private-token|evil.invalid|baseURL|apiKey/)
})

test("stale cached listings remain explicitly stale, never fresh entitlement", async () => {
  const { storage, values } = memoryStorage()
  const active = connection("one")
  await seed(storage, active)
  const key = catalogStorageKey(active)
  const saved = values.get(key) as any
  saved.catalog.fetchedAt = Date.now() - 48 * 60 * 60 * 1000
  values.set(key, saved)
  const controller = createDiscovery(context(storage, () => active), () => Effect.void)
  const status = await Effect.runPromise(controller.status)
  assert.equal(status.freshness, "stale")
  assert.equal(status.entitlement, "unverified")
  assert.equal(status.supportedModels, 1)
  assert.ok(status.ageMs! >= 48 * 60 * 60 * 1000)
})

test("account changes during storage read prevent publication", async () => {
  const shared = memoryStorage()
  await seed(shared.storage)
  let active: ActiveConnection | undefined = connection("one")
  const storage = { ...shared.storage, get: (key: string) => shared.storage.get(key).pipe(Effect.tap(() => Effect.sync(() => { active = undefined }))) }
  const controller = createDiscovery(context(storage, () => active), () => Effect.sync(() => { assert.fail("must not publish after logout") }))
  assert.equal((await Effect.runPromise(controller.status)).supportedModels, 0)
})

test("storage failures are sanitized and recover without publishing an unsaved refresh", async () => {
  const shared = memoryStorage()
  let failed = true
  const storage = { ...shared.storage,
    get: (key: string) => failed ? Effect.die(new Error("private-storage-path")) : shared.storage.get(key),
    set: (key: string, value: Parameters<typeof shared.storage.set>[1]) => failed ? Effect.die(new Error("private-storage-path")) : shared.storage.set(key, value),
  }
  let publications = 0
  const controller = createDiscovery(context(storage, () => connection("one")), () => Effect.sync(() => { publications++ }))
  const status = await Effect.runPromise(controller.status)
  assert.equal(status.storage, "unavailable")
  assert.doesNotMatch(JSON.stringify(status), /private-storage-path/)
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ data: [{ id: "claude-sonnet-4-6" }] })
  try {
    const result = await Effect.runPromise(controller.refresh)
    assert.match((result as { error: string }).error, /could not be saved/)
    assert.equal(publications, 0)
    assert.equal(shared.values.size, 0)
    failed = false
    await Effect.runPromise(controller.refresh)
    assert.equal((await Effect.runPromise(controller.status)).storage, "available")
    assert.equal(publications, 1)
  } finally { globalThis.fetch = original }
})

test("switch during a durable write never publishes the departing account", async () => {
  const shared = memoryStorage()
  let active = connection("one")
  const storage = { ...shared.storage, set: (key: string, value: Parameters<typeof shared.storage.set>[1]) => shared.storage.set(key, value).pipe(Effect.tap(() => Effect.sync(() => { active = connection("two") }))) }
  let notifications = 0
  const controller = createDiscovery(context(storage, () => active), () => Effect.sync(() => { assert.fail("must not publish the departing account") }), () => Effect.sync(() => { notifications++ }))
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ data: [{ id: "claude-sonnet-4-6" }] })
  try {
    const result = await Effect.runPromise(controller.refresh)
    assert.match((result as { error: string }).error, /connection changed/)
    assert.equal(notifications, 0)
    assert.equal((await Effect.runPromise(controller.status)).supportedModels, 0)
    assert.equal(shared.values.has(catalogStorageKey(active)), false)
  } finally { globalThis.fetch = original }
})

test("concurrent lazy and lifecycle synchronizations serialize storage reads and publish only once", { timeout: 2000 }, async () => {
  const shared = memoryStorage()
  await seed(shared.storage)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let readers = 0
  let maximumReaders = 0
  let publications = 0
  const storage = { ...shared.storage, get: (key: string) => Effect.gen(function* () {
    readers++
    maximumReaders = Math.max(maximumReaders, readers)
    entered()
    yield* Effect.promise(() => gate)
    return yield* shared.storage.get(key)
  }).pipe(Effect.ensuring(Effect.sync(() => { readers-- }))) }
  const controller = createDiscovery(context(storage, () => connection("one")), () => Effect.sync(() => { publications++ }))
  const lifecycle = Effect.runPromise(controller.synchronize)
  await started
  const lazy = Effect.runPromise(controller.status)
  const event = Effect.runPromise(controller.synchronize)
  release()
  await Promise.all([lifecycle, lazy, event])
  assert.equal(maximumReaders, 1)
  assert.equal(readers, 0)
  assert.equal(publications, 1)
})
