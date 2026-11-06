import { test } from "node:test"
import assert from "node:assert/strict"
import { make } from "@opencode/ai"
import { configure } from "@opencode/ai/providers/anthropic-compatible"
import { prepareRequest } from "../src/transport.js"

test("real 2.2.5 driver lowers messages and decodes fragmented Anthropic SSE", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    const request = await prepareRequest(new Request(input, init), "fake-access", ["claude-test"], 1000)
    assert.equal(request.url, "https://ingrazzio-cloud-prod.labs.jb.gg/v1/messages")
    const body = await request.json() as Record<string, unknown>
    assert.equal(body.model, "claude-test")
    assert.equal(body.stream, true)
    assert.ok(Array.isArray(body.messages))
    assert.deepEqual(body.output_config, { effort: "medium" })
    assert.deepEqual(body.thinking, { type: "adaptive" })
    const frames = [
      { type: "message_start", message: { id: "fake-id", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Olá" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "fake-tool", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"test"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("")
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of new TextEncoder().encode(frames)) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const client = make()
    const model = configure({ baseURL: "https://ingrazzio-cloud-prod.labs.jb.gg/v1", apiKey: "oauth-hook-placeholder", provider: "jetbrains", providerOptions: { effort: "medium", thinking: { type: "adaptive" } } }).model("claude-test")
    const events = []
    for await (const event of client.stream({ model, prompt: "test" })) events.push(event)
    assert.equal(calls, 1)
    assert.ok(events.some(event => event.type === "text-delta" && event.text === "Olá"))
    assert.ok(events.some(event => event.type === "tool-call"))
    assert.ok(events.some(event => event.type === "finish"))
  } finally { globalThis.fetch = originalFetch }
})
