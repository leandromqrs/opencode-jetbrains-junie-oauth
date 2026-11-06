import { test } from "node:test"
import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { withCancellation } from "../src/cancellation.js"

test("cancellation preserves operation results and failures and removes its listener", async () => {
  const controller = new AbortController()
  assert.equal(await withCancellation(Promise.resolve(42), controller.signal), 42)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  const failure = new Error("original failure")
  await assert.rejects(withCancellation(Promise.reject(failure), controller.signal), error => error === failure)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("abort rejects an uncooperative operation with the caller's error message", async () => {
  const controller = new AbortController()
  const pending = withCancellation(new Promise<never>(() => {}), controller.signal, "Quota service unavailable.")
  assert.equal(getEventListeners(controller.signal, "abort").length, 1)
  controller.abort("private abort reason")
  await assert.rejects(pending, { message: "Quota service unavailable." })
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("an already aborted signal rejects without retaining a listener", async () => {
  const signal = AbortSignal.abort("private abort reason")
  await assert.rejects(withCancellation(new Promise<never>(() => {}), signal), { message: "Cancelled" })
  assert.equal(getEventListeners(signal, "abort").length, 0)
})
