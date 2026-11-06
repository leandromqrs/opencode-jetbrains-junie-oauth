import { test } from "node:test"
import assert from "node:assert/strict"
import { prepareRequest, sanitizeResponse, UPSTREAM } from "../src/transport.js"

test("registry bindings reject cross-vendor routes and mismatched dated wire IDs", async () => {
  const binding = { id: "gpt-5.4", wireID: "gpt-5.4-2026-03-05", vendor: "openai" as const }
  const request = (path: string, model: string) => new Request(`${UPSTREAM}${path}`, { method: "POST", body: JSON.stringify({ model, input: [] }) })
  await assert.rejects(prepareRequest(request("/v1/messages", binding.wireID), "fake", [binding], 1000), /route/)
  await assert.rejects(prepareRequest(request("/v1/responses", binding.id), "fake", [binding], 1000), /route/)
  const valid = await prepareRequest(request("/v1/responses", binding.wireID), "fake", [binding], 1000)
  assert.equal(valid.headers.get("x-llm-model"), "openai")
})

test("native request keeps tools, strips foreign credentials and blocks redirects", async () => {
  const body = { model: "claude-test", max_tokens: 123, messages: [{ role: "user", content: "test" }], stream: true, tools: [{ name: "test", input_schema: { type: "object" } }] }
  const request = await prepareRequest(new Request(`${UPSTREAM}/v1/messages`, {
    method: "POST", headers: { "X-API-Key": "foreign", Cookie: "foreign", Authorization: "foreign", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body),
  }), "fake-access", ["claude-test"], 1000)
  assert.equal(request.redirect, "error")
  assert.equal(request.headers.get("x-api-key"), null)
  assert.equal(request.headers.get("cookie"), null)
  assert.equal(request.headers.get("authorization"), "Bearer fake-access")
  assert.equal(request.headers.get("x-llm-model"), "anthropic")
  assert.equal(request.headers.get("x-keep-path"), "true")
  assert.deepEqual(await request.json(), body)
})

test("unapproved hosts, routes, and models never receive credentials", async () => {
  for (const url of ["http://ingrazzio-cloud-prod.labs.jb.gg/v1/messages", "https://example.com/v1/messages", `${UPSTREAM}/v1/models`, `${UPSTREAM}/v1/messages?token=secret`]) {
    await assert.rejects(prepareRequest(new Request(url, { method: "POST", body: "{}" }), "fake", [], 1000))
  }
  await assert.rejects(prepareRequest(new Request(`${UPSTREAM}/v1/messages`, { method: "POST", body: '{"model":"not-configured"}' }), "fake", ["claude-test"], 1000))
})

test("caller cancellation propagates to the final request", async () => {
  const controller = new AbortController()
  const request = await prepareRequest(new Request(`${UPSTREAM}/v1/messages`, { method: "POST", body: '{"model":"claude-test"}', signal: controller.signal }), "fake", ["claude-test"], 1000)
  controller.abort()
  assert.equal(request.signal.aborted, true)
})

test("upstream failures are sanitized, including rate/license/auth errors", async () => {
  for (const status of [302, 401, 403, 429, 477, 500]) {
    const response = await sanitizeResponse(new Response("fake-secret upstream debug", { status, headers: { Location: "https://evil.test", "Set-Cookie": "fake-secret" } }))
    assert.equal(response.status, status)
    assert.equal(response.headers.get("location"), null)
    assert.equal(response.headers.get("set-cookie"), null)
    assert.ok(!(await response.text()).includes("fake-secret"))
  }
})

test("successful fragmented native SSE is preserved byte-for-byte", async () => {
  const frames = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Olá"}}\n\nevent: content_block_delta\ndata: {"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  const bytes = new TextEncoder().encode(frames)
  const original = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
  assert.equal(await (await sanitizeResponse(original)).text(), frames)
})
