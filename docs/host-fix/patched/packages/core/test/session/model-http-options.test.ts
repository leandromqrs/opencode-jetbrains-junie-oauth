import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type RequestListener, type Server } from "node:http"
import { Effect, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { withWebRequestOptions } from "../../src/session/model-http-options.js"

async function listen(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function execute(request: Request, consume = false, onHeaders?: () => void) {
  const sent = HttpClientRequest.bodyUint8Array(
    HttpClientRequest.fromWeb(request), new TextEncoder().encode("FAKE-CONVERSATION"), "text/plain",
  )
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* withWebRequestOptions(request, http.execute(sent))
    onHeaders?.()
    if (consume) yield* Stream.runDrain(response.stream)
    return response.status
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
}

for (const status of [303, 307]) {
  test(`final fetch refuses ${status} without reaching the redirect target`, async () => {
    let targets = 0
    let sources = 0
    const target = await listen((_req, res) => { targets++; res.end("unexpected") })
    const source = await listen((_req, res) => { sources++; res.writeHead(status, { Location: target.url }); res.end() })
    try {
      const request = new Request(source.url, { method: "POST", body: "FAKE-CONVERSATION", redirect: "error" })
      await assert.rejects(Effect.runPromise(execute(request)))
      assert.equal(sources, 1)
      assert.equal(targets, 0)
    } finally { await close(source.server); await close(target.server) }
  })
}

test("a hook deadline aborts an in-flight fetch and closes its connection", async () => {
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  let sourceReached = false
  const source = await listen((req) => { sourceReached = true; req.socket.once("close", resolveClosed) })
  try {
    const request = new Request(source.url, { method: "POST", body: "fake", signal: AbortSignal.timeout(150) })
    await assert.rejects(Effect.runPromise(execute(request)))
    assert.equal(sourceReached, true)
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Connection remained open")), 1000).unref())])
  } finally { await close(source.server) }
})

test("an already-aborted hook signal prevents dispatch", async () => {
  let requests = 0
  const source = await listen((_req, res) => { requests++; res.end() })
  try {
    const request = new Request(source.url, { method: "POST", body: "fake", signal: AbortSignal.abort() })
    await assert.rejects(Effect.runPromise(execute(request)))
    assert.equal(requests, 0)
  } finally { await close(source.server) }
})

test("the hook signal still aborts the response stream after headers", async () => {
  const controller = new AbortController()
  const source = await listen((_req, res) => { res.writeHead(200); res.write("partial") })
  try {
    const request = new Request(source.url, { method: "POST", body: "fake", signal: controller.signal })
    await assert.rejects(Effect.runPromise(execute(request, true, () => controller.abort())))
  } finally { await close(source.server) }
})

test("scoped fetch preserves Effect cancellation and inherited fetch options", async () => {
  let signal: AbortSignal | undefined
  let redirect: RequestRedirect | undefined
  const original = globalThis.fetch
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.cache, "no-store")
    signal = init?.signal ?? undefined
    redirect = init?.redirect
    return await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }))
  }
  const request = new Request("http://127.0.0.1:1", { method: "POST", body: "fake", redirect: "error" })
  const controller = new AbortController()
  const pending = Effect.runPromise(execute(request).pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetcher),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "follow", cache: "no-store" }),
  ), { signal: controller.signal })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(signal?.aborted, false)
  assert.equal(redirect, "error")
  controller.abort()
  await assert.rejects(pending)
  assert.equal(signal?.aborted, true)
  assert.equal(globalThis.fetch, original)
})
