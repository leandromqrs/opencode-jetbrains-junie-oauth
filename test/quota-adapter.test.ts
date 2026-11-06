import { test } from "node:test"
import assert from "node:assert/strict"
import { quotaAdapterConfig, startQuotaAdapter } from "../src/quota-adapter.js"

const token = "adapter-test-only-key-0123456789abcdef"
const location = "/var/home/leandromqrs/Projects/LuminusOS"
const balance = { state: "available", amount: 19.89, unit: "credits", observedAt: "2026-11-05T12:00:00.000Z" }
const endpoint = { url: "http://127.0.0.1:40001", auth: { type: "basic" as const, username: "opencode", password: "fake-service-password" } }
const request = (url: string, signal?: AbortSignal) => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal })

test("adapter uses supported RPC with explicit location and native service auth, never its own key", async t => {
  let discoveries = 0
  const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => { discoveries++; return endpoint }, fetch: async (input, init) => {
    const forwarded = new Request(input, init)
    const url = new URL(forwarded.url)
    assert.equal(url.pathname, "/api/rpc/jetbrains-junie/quota")
    assert.equal(url.searchParams.get("location[directory]"), location)
    assert.equal(forwarded.method, "POST")
    assert.equal(forwarded.redirect, "error")
    assert.deepEqual(await forwarded.json(), { input: {} })
    assert.equal(forwarded.headers.get("authorization"), `Basic ${Buffer.from("opencode:fake-service-password").toString("base64")}`)
    assert.ok(!JSON.stringify([...forwarded.headers]).includes(token))
    return Response.json({ output: { ...balance, username: "private" } })
  } })
  t.after(() => adapter.close())
  assert.equal(discoveries, 0)
  assert.equal((await fetch(adapter.url)).status, 401)
  assert.equal(discoveries, 0)
  const response = await request(adapter.url)
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.equal(JSON.parse(body).entries[0].value, "19.89 credits")
  assert.ok(!body.includes("private"))
  assert.equal(discoveries, 1)
})

test("temporary service absence, plugin reload and service replacement recover without balance caching", async t => {
  let current: typeof endpoint | undefined
  let failed = false
  let requests = 0
  const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => current, fetch: async input => {
    requests++
    if (failed) return Response.json({ error: { type: "rpc.not_found", message: "private" } }, { status: 404 })
    return Response.json({ output: { ...balance, amount: new URL(input instanceof Request ? input.url : String(input)).port === "40002" ? 7 : 19.89 } })
  } })
  t.after(() => adapter.close())
  assert.equal((await request(adapter.url)).status, 503)
  current = endpoint
  assert.equal((await request(adapter.url)).status, 200)
  failed = true
  assert.equal((await request(adapter.url)).status, 503)
  failed = false
  current = { ...endpoint, url: "http://127.0.0.1:40002" }
  const response = await request(adapter.url)
  assert.equal(JSON.parse(await response.text()).entries[0].value, "7.00 credits")
  assert.equal(requests, 3)
})

test("adapter bounds RPC output and sanitizes transport errors", async t => {
  for (const fetcher of [
    async () => { throw new Error(`private ${token}`) },
    async () => new Response("x".repeat(65_537)),
    async () => Response.json({ output: { ...balance, unit: "private" } }),
    async () => Response.json({ output: { ...balance, amount: NaN } }),
  ]) {
    const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => endpoint, fetch: fetcher })
    t.after(() => adapter.close())
    const response = await request(adapter.url)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "Quota unavailable" })
  }
})

test("RPC signal aborts when the authenticated caller disconnects", async t => {
  let notify: () => void = () => {}
  const started = new Promise<void>(resolve => { notify = resolve })
  let upstreamSignal: AbortSignal | undefined
  const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => endpoint, fetch: async (input, init) => {
    upstreamSignal = new Request(input, init).signal
    notify()
    return new Promise<Response>(() => {})
  } })
  t.after(() => adapter.close())
  const controller = new AbortController()
  const pending = request(adapter.url, controller.signal).catch(() => undefined)
  await started
  const aborted = new Promise<void>(resolve => upstreamSignal!.addEventListener("abort", () => resolve(), { once: true }))
  controller.abort()
  await pending
  await aborted
  assert.equal(upstreamSignal?.aborted, true)
})

test("stalled discovery times out without starting or stopping any service", async t => {
  const adapter = await startQuotaAdapter({ port: 0, token, location, requestTimeoutMs: 25, discover: async () => new Promise(() => {}) })
  t.after(() => adapter.close())
  assert.equal((await request(adapter.url)).status, 503)
})

test("explicit target and key environment are required; CLI never defaults to cwd", async () => {
  assert.deepEqual(quotaAdapterConfig(["--location", location], { JUNIE_QUOTA_ADAPTER_KEY: token }), { location, port: 62365, token })
  assert.deepEqual(quotaAdapterConfig(["--location", location, "--port", "62366", "--api-key-env", "OTHER_KEY"], { OTHER_KEY: token }), { location, port: 62366, token })
  for (const args of [[], ["--location", "."], ["--location", location, "--port", "0"], ["--location", location, "--token", token]]) {
    assert.throws(() => quotaAdapterConfig(args, { JUNIE_QUOTA_ADAPTER_KEY: token }), /Invalid quota adapter configuration/)
  }
  assert.throws(() => quotaAdapterConfig(["--location", location], {}), /Invalid quota adapter configuration/)
  await assert.rejects(startQuotaAdapter({ port: 0, token, location: "." }), /Invalid quota adapter configuration/)
})

test("duplicate adapter start fails without disturbing the first listener", async t => {
  const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => undefined })
  t.after(() => adapter.close())
  await assert.rejects(startQuotaAdapter({ port: Number(new URL(adapter.url).port), token, location, discover: async () => undefined }), /Unable to start quota bridge/)
  assert.equal((await request(adapter.url)).status, 503)
})

test("native unavailable state remains a supported status row", async t => {
  const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => endpoint, fetch: async () => Response.json({ output: { state: "unavailable", reason: "unauthorized", observedAt: balance.observedAt } }) })
  t.after(() => adapter.close())
  const response = await request(adapter.url)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).entries[0].value, "Unavailable")
})

test("nonlocal discovery cannot receive service credentials or quota requests", async t => {
  let calls = 0
  const adapter = await startQuotaAdapter({ port: 0, token, location, discover: async () => ({ ...endpoint, url: "https://example.com" }), fetch: async () => { calls++; throw new Error("Unexpected request") } })
  t.after(() => adapter.close())
  assert.equal((await request(adapter.url)).status, 503)
  assert.equal(calls, 0)
})

test("a stalled RPC body is cancelled on the request deadline", async t => {
  let cancelled = false
  const adapter = await startQuotaAdapter({ port: 0, token, location, requestTimeoutMs: 25, discover: async () => endpoint, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
  t.after(() => adapter.close())
  assert.equal((await request(adapter.url)).status, 503)
  assert.equal(cancelled, true)
})
