import { test } from "node:test"
import assert from "node:assert/strict"
import { formatJunieBalance, getJunieBalance, parseJunieBalance, toJunieQuotaV1 } from "../src/quota.js"

const observedAt = "2026-11-05T12:00:00.000Z"

test("live-observed CREDITS unit normalizes by 100000", () => {
  const balance = parseJunieBalance({ active: true, balanceLeft: 1_989_000, balanceUnit: "CREDITS", licenseType: "AIP" }, observedAt)
  assert.deepEqual(balance, { state: "available", amount: 19.89, unit: "credits", license: "AIP", observedAt })
  assert.equal(formatJunieBalance(balance), "19.89 credits")
})

test("raw credit balances normalize by 100000 without account metadata", () => {
  const balance = parseJunieBalance({ active: true, balanceLeft: 1_989_000, balanceUnit: "CREDIT", licenseType: "SEAT", username: "private@example.test", authType: "private", meta: { private: true } }, observedAt)
  assert.deepEqual(balance, { state: "available", amount: 19.89, unit: "credits", license: "SEAT", observedAt })
  assert.equal(formatJunieBalance(balance), "19.89 credits")
  assert.deepEqual(toJunieQuotaV1(balance), { version: "quota-v1", entries: [{ kind: "value", name: "balance", label: "Junie balance", resultType: "balance", value: "19.89 credits", observedAtIso: observedAt }] })
})

test("USD remains unscaled and missing units use the native credit default", () => {
  assert.deepEqual(parseJunieBalance({ balanceLeft: 19.89, balanceUnit: "USD" }, observedAt), { state: "available", amount: 19.89, unit: "USD", observedAt })
  for (const balanceUnit of [undefined, null]) {
    const balance = parseJunieBalance({ balanceLeft: 100_000, balanceUnit }, observedAt)
    assert.equal(balance.state, "available")
    if (balance.state === "available") assert.equal(balance.amount, 1)
  }
  assert.equal(formatJunieBalance(parseJunieBalance({ balanceLeft: 19.89, balanceUnit: "USD" })), "19.89 USD")
})

test("unknown units and invalid amounts never become a zero credit balance", () => {
  for (const balanceUnit of ["EUR", "credits", "", 1, {}, "USD\nprivate"]) {
    assert.equal(parseJunieBalance({ balanceLeft: 100_000, balanceUnit }).state, "unavailable")
  }
  for (const balanceLeft of [undefined, null, NaN, Infinity, -Infinity, -1, Number.MAX_VALUE, "1989000", {}, [], true]) {
    const balance = parseJunieBalance({ balanceLeft, balanceUnit: "CREDIT" })
    assert.equal(balance.state, "unavailable")
    assert.equal("amount" in balance, false)
    assert.equal(formatJunieBalance(balance), "Unavailable")
    assert.equal(toJunieQuotaV1(balance).entries[0].resultType, "status")
  }
  assert.equal(parseJunieBalance({ balanceLeft: 0, balanceUnit: "CREDIT" }).state, "available")
})

test("inactive, NONE and GZL licenses hide balances; arbitrary license data is not exposed", () => {
  for (const payload of [{ active: false }, { licenseType: "NONE" }, { licenseType: "GZL" }]) {
    assert.equal(parseJunieBalance({ balanceLeft: 100_000, balanceUnit: "CREDIT", ...payload }).state, "unavailable")
  }
  assert.equal("license" in parseJunieBalance({ balanceLeft: 100_000, licenseType: "private@example.test" }), false)
  for (const payload of [null, [], "private", 1, { active: "true", balanceLeft: 1 }]) {
    assert.equal(parseJunieBalance(payload).state, "unavailable")
  }
})

test("fetch uses only fixed HTTPS metadata GET and explicit routing headers", async () => {
  const balance = await getJunieBalance("fake-access", {
    routingHeaders: { "X-Forced-License": "approved-license", "X-Accept-Release-License": "true" },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      assert.equal(request.url, "https://ingrazzio-cloud-prod.labs.jb.gg/auth/test")
      assert.equal(request.method, "GET")
      assert.equal(request.redirect, "error")
      assert.equal(request.headers.get("authorization"), "Bearer fake-access")
      assert.equal(request.headers.get("x-forced-license"), "approved-license")
      assert.equal(request.headers.get("x-accept-release-license"), "true")
      assert.equal(request.headers.get("x-forced-license-free"), null)
      assert.equal(request.headers.get("x-accept-eap-license"), null)
      assert.equal(request.body, null)
      return Response.json({ balanceLeft: 200_000, balanceUnit: "CREDIT", username: "private" })
    },
  })
  assert.equal(balance.state, "available")
  assert.ok(!JSON.stringify(balance).includes("private"))
})

test("no license/agreement flags are invented and foreign routing headers fail closed", async () => {
  await getJunieBalance("fake", { fetch: async (_input, init) => {
    assert.deepEqual([...new Headers(init?.headers).keys()].sort(), ["accept", "authorization"])
    return Response.json({ balanceLeft: 0, balanceUnit: "CREDIT" })
  } })
  const foreignHeaders: Record<string, string>[] = [{ Authorization: "foreign" }, { Cookie: "private" }, { "X-Forced-License": "bad\r\nvalue" }]
  for (const routingHeaders of foreignHeaders) {
    const balance = await getJunieBalance("fake", { routingHeaders, fetch: async () => { throw new Error("must not fetch") } })
    assert.equal(balance.state, "unavailable")
    if (balance.state === "unavailable") assert.equal(balance.reason, "invalid-context")
  }
})

test("HTTP, redirect and network failures never expose upstream bodies or exception messages", async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    let cancelled = false
    const balance = await getJunieBalance("fake", { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status, headers: { Location: "https://private.test" } }) })
    assert.equal(balance.state, "unavailable")
    assert.equal(cancelled, true)
    assert.ok(!JSON.stringify(balance).includes("private"))
  }
  const balance = await getJunieBalance("fake", { fetch: async () => { throw new Error("private fake-access") } })
  assert.equal(balance.state, "unavailable")
  assert.ok(!JSON.stringify(balance).includes("fake-access"))
})

test("JSON type and body bounds reject malformed, oversized and incomplete metadata", async () => {
  for (const response of [new Response("private", { headers: { "content-type": "text/html" } }), new Response("private", { headers: { "content-type": "application/json" } }), Response.json([]), Response.json({ balanceLeft: 1 }, { headers: { "content-length": "65537" } }), new Response(" ".repeat(65_537), { headers: { "content-type": "application/json" } })]) {
    const balance = await getJunieBalance("fake", { fetch: async () => response })
    assert.equal(balance.state, "unavailable")
    assert.ok(!JSON.stringify(balance).includes("private"))
  }
})

test("streamed metadata is decoded across byte boundaries", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ balanceLeft: 1989000, balanceUnit: "CREDIT", username: "privaté" }))
  const balance = await getJunieBalance("fake", { fetch: async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }), { headers: { "content-type": "application/json; charset=utf-8" } }) })
  assert.equal(balance.state, "available")
  if (balance.state === "available") assert.equal(balance.amount, 19.89)
})

test("already cancelled requests do not fetch; cancellation interrupts a stalled body", async () => {
  const controller = new AbortController()
  controller.abort("private cancellation reason")
  let fetched = false
  const preAborted = await getJunieBalance("fake", { signal: controller.signal, fetch: async () => { fetched = true; return Response.json({}) } })
  assert.equal(fetched, false)
  assert.equal(preAborted.state, "unavailable")
  if (preAborted.state === "unavailable") assert.equal(preAborted.reason, "cancelled")
  let cancelled = false
  const reading = new AbortController()
  const promise = getJunieBalance("fake", { signal: reading.signal, fetch: async () => new Response(new ReadableStream({ pull() { reading.abort("private") }, cancel() { cancelled = true } }), { headers: { "content-type": "application/json" } }) })
  const balance = await promise
  assert.equal(balance.state, "unavailable")
  if (balance.state === "unavailable") assert.equal(balance.reason, "cancelled")
  assert.equal(cancelled, true)
})

test("timeout bounds an uncooperative fetch without leaking the token", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let signal: AbortSignal | null | undefined
  const pending = getJunieBalance("fake-access", { fetch: async (_input, init) => { signal = init?.signal; return new Promise<Response>(() => {}) } })
  context.mock.timers.tick(10_000)
  const balance = await pending
  assert.equal(signal?.aborted, true)
  assert.equal(balance.state, "unavailable")
  if (balance.state === "unavailable") assert.equal(balance.reason, "timeout")
})

test("timeout also bounds a stalled body and cancels its reader", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let cancelled = false
  let notifyReading: () => void = () => {}
  const reading = new Promise<void>(resolve => { notifyReading = resolve })
  const response = new Response(new ReadableStream({ pull() { notifyReading() }, cancel() { cancelled = true } }), { headers: { "content-type": "application/json" } })
  const pending = getJunieBalance("fake", { fetch: async () => response })
  await reading
  context.mock.timers.tick(10_000)
  const balance = await pending
  assert.equal(balance.state, "unavailable")
  if (balance.state === "unavailable") assert.equal(balance.reason, "timeout")
  assert.equal(cancelled, true)
})

test("stream byte bounds override an understated content length and cancel without waiting", async () => {
  let cancelled = false
  const balance = await getJunieBalance("fake", { fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(32_768))
    controller.enqueue(new Uint8Array(32_769))
  }, cancel() { cancelled = true; return new Promise<void>(() => {}) } }), { headers: { "content-type": "application/json", "content-length": "1" } }) })
  assert.equal(balance.state, "unavailable")
  if (balance.state === "unavailable") assert.equal(balance.reason, "body-too-large")
  assert.equal(cancelled, true)
})

test("invalid credentials do not fetch and separate callers never share a balance cache", async () => {
  for (const accessToken of ["", "bad\r\nheader", "has spaces", "a".repeat(32_769)]) {
    const balance = await getJunieBalance(accessToken, { fetch: async () => { assert.fail("invalid token must not fetch") } })
    assert.equal(balance.state, "unavailable")
    if (balance.state === "unavailable") assert.equal(balance.reason, "invalid-credentials")
  }
  let calls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    calls++
    return Response.json({ balanceLeft: new Headers(init?.headers).get("authorization") === "Bearer account-one" ? 100_000 : 200_000, balanceUnit: "CREDIT" })
  }
  const first = await getJunieBalance("account-one", { fetch: fetcher })
  const second = await getJunieBalance("account-two", { fetch: fetcher })
  assert.equal(calls, 2)
  if (first.state !== "available" || second.state !== "available") assert.fail("expected independent account balances")
  assert.equal(first.amount, 1)
  assert.equal(second.amount, 2)
})
