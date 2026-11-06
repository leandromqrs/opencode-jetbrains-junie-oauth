import { test } from "node:test"
import assert from "node:assert/strict"
import { make } from "@opencode/ai"
import { configure as openai } from "@opencode/ai/providers/openai"
import { configure as xai } from "@opencode/ai/providers/xai"
import { configure as google } from "@opencode/ai/providers/google"
import { prepareRequest, UPSTREAM } from "../src/transport.js"
import { GOOGLE_BASE, type ModelBinding } from "../src/inventory.js"

test("native OpenAI, Grok and Google drivers preserve tools, effort, fragmented SSE and fixed routing", async () => {
  const original = globalThis.fetch
  let vendor: "google" | "grok" | "openai" = "openai"
  let wireID = ""
  let binding: ModelBinding
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    const native = new Request(input, init)
    assert.equal(native.url, vendor === "google" ? `${GOOGLE_BASE}/models/${wireID}:streamGenerateContent?alt=sse` : `${UPSTREAM}/v1/responses`)
    const final = await prepareRequest(native, "fake-access", [binding], 1000)
    assert.equal(final.headers.get("x-llm-model"), vendor)
    assert.equal(final.headers.get("x-goog-api-key"), null)
    assert.equal(final.redirect, "error")
    const payload = await final.json() as any
    let frames: unknown[]
    if (vendor === "google") {
      assert.equal(final.url, `${GOOGLE_BASE}/models/${wireID}:streamGenerateContent?alt=sse`)
      assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, "medium")
      assert.ok(payload.tools[0].functionDeclarations.length)
      frames = [{ candidates: [{ content: { role: "model", parts: [{ text: "Olá" }, { functionCall: { id: "tool_1", name: "lookup", args: { q: "test" } }, thoughtSignature: "mock-signature" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }]
    } else {
      assert.equal(final.url, `${UPSTREAM}/v1/responses`)
      assert.equal(payload.model, wireID)
      assert.equal(payload.reasoning.effort, "medium")
      assert.ok(payload.tools.length)
      frames = [
        { type: "response.created", response: { id: "mock-response", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
        { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Olá" },
        { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "tool_1", name: "lookup", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"q":"test"}' },
        { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "tool_1", name: "lookup", arguments: '{"q":"test"}' } },
        { type: "response.completed", response: { id: "mock-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
      ]
    }
    const bytes = new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""))
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
      controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })
  }
  try {
    for (vendor of ["openai", "grok", "google"] as const) {
    calls = 0
    wireID = vendor === "google" ? "gemini-3.7-flash" : vendor === "grok" ? "grok-4.6" : "gpt-5.4-2026-03-05"
    binding = { id: wireID, wireID, vendor }
    const config = { baseURL: `${UPSTREAM}/v1`, apiKey: "placeholder", providerOptions: { reasoningEffort: "medium" as const } }
    const model = vendor === "google" ? google({ baseURL: GOOGLE_BASE, apiKey: "placeholder", providerOptions: { thinkingConfig: { thinkingLevel: "medium" } } }).model(wireID)
      : vendor === "grok" ? xai(config).model(wireID) : openai(config).model(wireID)
    const events = []
    for await (const event of make().stream({ model, prompt: "test", tools: [{ name: "lookup", description: "test", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] })) events.push(event)
    assert.equal(calls, 1)
    assert.ok(events.some(event => event.type === "text-delta" && event.text === "Olá"))
    assert.ok(events.some(event => event.type === "tool-call"))
    assert.ok(events.some(event => event.type === "finish"))
    }
  } finally { globalThis.fetch = original }
})
