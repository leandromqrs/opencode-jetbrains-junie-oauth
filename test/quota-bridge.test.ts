import { test } from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import { connect } from "node:net"
import { getEventListeners, once } from "node:events"
import { startQuotaBridge } from "../src/quota-bridge.js"
import { parseJunieBalance, toJunieQuotaV1, type JunieBalance } from "../src/quota.js"

const token = "adapter-test-key-" + "a".repeat(48)
const balance = parseJunieBalance({ balanceLeft: 1_989_000, balanceUnit: "CREDIT", licenseType: "SEAT" }, "2026-11-05T12:00:00.000Z")

async function query(url: string, options: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: options.path ?? target.pathname, method: options.method ?? "GET", headers: options.headers ?? { Authorization: `Bearer ${token}` }, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on("data", chunk => chunks.push(Buffer.from(chunk)))
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      response.once("error", reject)
    })
    req.once("error", reject)
    req.setTimeout(5_000, () => req.destroy(new Error("Test request timeout")))
    req.end()
  })
}

test("bridge binds loopback and exposes only the balance quota-v1 projection", async context => {
  let calls = 0
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: async signal => { assert.equal(signal.aborted, false); calls++; return balance } })
  context.after(() => bridge.close())
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/quota$/)
  const response = await query(bridge.url)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), toJunieQuotaV1(balance))
  assert.equal(calls, 1)
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8")
  assert.equal(response.headers["cache-control"], "no-store")
  assert.equal(response.headers["access-control-allow-origin"], undefined)
  assert.equal(response.headers["connection"], "close")
  assert.equal(response.body.includes(token), false)
})

test("invalid adapter authentication never requests a balance", async context => {
  let calls = 0
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: async () => { calls++; return balance } })
  context.after(() => bridge.close())
  for (const authorization of [undefined, "", `Basic ${token}`, `Bearer ${token}x`, "Bearer short", "Bearer " + "x".repeat(1_024)]) {
    const response = await query(bridge.url, { headers: authorization === undefined ? {} : { Authorization: authorization } })
    assert.equal(response.status, 401)
    assert.equal(response.body.includes(token), false)
    assert.equal(response.headers["access-control-allow-origin"], undefined)
  }
  assert.equal(calls, 0)
})

test("method, raw path, query, Host and browser-origin restrictions precede balance reads", async context => {
  let calls = 0
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: async () => { calls++; return balance } })
  context.after(() => bridge.close())
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await query(bridge.url, { method })
    assert.equal(response.status, 405)
    assert.equal(response.headers.allow, "GET")
  }
  for (const path of ["/", "/quota/", "/quota?", "/quota?key=private", "/%71uota", "http://127.0.0.1/quota"]) {
    assert.equal((await query(bridge.url, { path })).status, 404)
  }
  for (const Host of ["evil.test", "localhost", "127.0.0.1", "127.0.0.1:1", `${new URL(bridge.url).host}.evil.test`]) {
    assert.equal((await query(bridge.url, { headers: { Authorization: `Bearer ${token}`, Host } })).status, 400)
  }
  assert.equal((await query(bridge.url, { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.test" } })).status, 403)
  assert.equal((await query(bridge.url, { headers: { Authorization: `Bearer ${token}`, "Content-Length": "1" } })).status, 400)
  assert.equal((await query(bridge.url, { headers: { Authorization: `Bearer ${token}`, "Transfer-Encoding": "chunked" } })).status, 400)
  assert.equal(calls, 0)
})

test("unavailable balance is an explicit quota-v1 status, not zero or a percentage", async context => {
  const unavailable = parseJunieBalance({ balanceLeft: null }, "2026-11-05T12:00:00.000Z")
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: async () => unavailable })
  context.after(() => bridge.close())
  const response = await query(bridge.url)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), toJunieQuotaV1(unavailable))
  assert.equal(JSON.parse(response.body).entries[0].resultType, "status")
  assert.equal(JSON.parse(response.body).entries[0].value, "Unavailable")
  assert.equal(response.body.includes("percent"), false)
})

test("callback failures and malformed balance output produce sanitized 503 errors", async context => {
  const callbacks = [
    async (): Promise<JunieBalance> => { throw new Error(`private ${token}`) },
    async (): Promise<JunieBalance> => ({ state: "available", amount: Infinity, unit: "credits", observedAt: "2026-11-05T12:00:00.000Z" }),
    async (): Promise<JunieBalance> => ({ state: "available", amount: 1, unit: "credits", observedAt: `private ${token}` }),
  ]
  for (const getBalance of callbacks) {
    const bridge = await startQuotaBridge({ port: 0, token, getBalance })
    context.after(() => bridge.close())
    const response = await query(bridge.url)
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.body), { error: "Quota unavailable" })
    assert.equal(response.body.includes(token), false)
  }
})

test("callback timeout is bounded even when callback ignores cancellation", async context => {
  let callbackSignal: AbortSignal | undefined
  const bridge = await startQuotaBridge({ port: 0, token, requestTimeoutMs: 25, getBalance: signal => { callbackSignal = signal; return new Promise<JunieBalance>(() => {}) } })
  context.after(() => bridge.close())
  const response = await query(bridge.url)
  assert.equal(response.status, 503)
  assert.equal(callbackSignal?.aborted, true)
})

test("close is idempotent, stops stalled requests and releases the explicit port", async () => {
  let notifyReading: () => void = () => {}
  const reading = new Promise<void>(resolve => { notifyReading = resolve })
  let callbackSignal: AbortSignal | undefined
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: signal => { callbackSignal = signal; notifyReading(); return new Promise<JunieBalance>(() => {}) } })
  const pending = query(bridge.url).catch(() => undefined)
  await reading
  await Promise.all([bridge.close(), bridge.close()])
  assert.equal(callbackSignal?.aborted, true)
  await pending
  await assert.rejects(query(bridge.url))
  const replacement = await startQuotaBridge({ port: Number(new URL(bridge.url).port), token, getBalance: async () => balance })
  await replacement.close()
})

test("abort closes incomplete header connections and removes its lifecycle listener", async () => {
  const lifecycle = new AbortController()
  const bridge = await startQuotaBridge({ port: 0, token, signal: lifecycle.signal, getBalance: async () => balance })
  assert.equal(getEventListeners(lifecycle.signal, "abort").length, 1)
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(bridge.url).port) })
  await once(socket, "connect")
  socket.on("error", () => {})
  socket.write("GET /quota HTTP/1.1\r\n")
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()))
  lifecycle.abort()
  await bridge.close()
  await closed
  assert.equal(getEventListeners(lifecycle.signal, "abort").length, 0)
  await assert.rejects(query(bridge.url))
})

test("an occupied port fails safely without closing the existing bridge", async context => {
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: async () => balance })
  context.after(() => bridge.close())
  await assert.rejects(startQuotaBridge({ port: Number(new URL(bridge.url).port), token, getBalance: async () => balance }), /^Error: Unable to start quota bridge\.$/)
  assert.equal((await query(bridge.url)).status, 200)
})

test("oversized and duplicate authentication headers are rejected without invoking the callback", async context => {
  let calls = 0
  const bridge = await startQuotaBridge({ port: 0, token, getBalance: async () => { calls++; return balance } })
  context.after(() => bridge.close())
  const oversized = await query(bridge.url, { headers: { Authorization: `Bearer ${token}`, "X-Oversized": "x".repeat(9_000) } })
  assert.ok([400, 431].includes(oversized.status))
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(bridge.url).port) })
  await once(socket, "connect")
  let text = ""
  socket.on("data", chunk => { text += chunk.toString() })
  const closed = once(socket, "close")
  socket.end(`GET /quota HTTP/1.1\r\nHost: ${new URL(bridge.url).host}\r\nAuthorization: Bearer ${token}\r\nAuthorization: Bearer ${token}\r\n\r\n`)
  await closed
  assert.match(text, /^HTTP\/1\.1 (400|401)/)
  assert.equal(text.includes(token), false)
  assert.equal(calls, 0)
})

test("invalid options fail closed without echoing configuration values", async () => {
  for (const port of [-1, 65_536, NaN, 1.5]) {
    await assert.rejects(startQuotaBridge({ port, token, getBalance: async () => balance }), /^Error: Invalid quota bridge options\.$/)
  }
  for (const invalidToken of ["", "short", "x".repeat(513), "x".repeat(32) + "\nprivate"]) {
    await assert.rejects(startQuotaBridge({ port: 0, token: invalidToken, getBalance: async () => balance }), /^Error: Invalid quota bridge options\.$/)
  }
  for (const requestTimeoutMs of [0, 30_001, NaN, 1.5]) {
    await assert.rejects(startQuotaBridge({ port: 0, token, requestTimeoutMs, getBalance: async () => balance }), /^Error: Invalid quota bridge options\.$/)
  }
  const controller = new AbortController()
  controller.abort(`private ${token}`)
  await assert.rejects(startQuotaBridge({ port: 0, token, signal: controller.signal, getBalance: async () => balance }), /^Error: Quota bridge start cancelled\.$/)
})
