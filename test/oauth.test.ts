import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { beginLogin, exchangeToken, singleFlightRefresh } from "../src/oauth.js"

test("PKCE loopback login exchanges only a matching state and exact redirect", async () => {
  let form: URLSearchParams | undefined
  const login = await beginLogin({ ports: [0], fetch: async (url, init) => {
    assert.equal(url, "https://oauth.account.jetbrains.com/oauth2/token")
    assert.equal(init?.redirect, "error")
    form = new URLSearchParams(String(init?.body))
    return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 })
  } })
  try {
    const auth = new URL(login.url)
    assert.equal(auth.origin + auth.pathname, "https://junie.jetbrains.com/cli-auth")
    assert.equal(auth.searchParams.get("scope"), "offline_access openid jb-authn-service")
    const callback = new URL(auth.searchParams.get("redirect_uri")!)
    callback.hostname = "127.0.0.1"
    callback.searchParams.set("code", "fake-code")
    callback.searchParams.set("state", "wrong")
    assert.equal((await fetch(callback)).status, 400)
    callback.searchParams.set("state", "é".repeat(64))
    assert.equal((await fetch(callback)).status, 400)
    assert.equal(form, undefined)
    callback.searchParams.set("state", auth.searchParams.get("state")!)
    assert.equal((await fetch(callback)).status, 200)
    const credential = await login.callback
    assert.equal(credential.access, "fake-access")
    assert.equal(form!.get("grant_type"), "authorization_code")
    assert.equal(form!.get("redirect_uri"), auth.searchParams.get("redirect_uri"))
    assert.equal(createHash("sha256").update(form!.get("code_verifier")!).digest("base64url"), auth.searchParams.get("code_challenge"))
  } finally { login.cancel() }
})

test("token failures never include upstream bodies or network error secrets", async () => {
  for (const fetcher of [async () => new Response("fake-secret", { status: 401 }), async () => { throw new Error("fake-secret") }]) {
    await assert.rejects(exchangeToken(new URLSearchParams(), fetcher), error => error instanceof Error && !error.message.includes("fake-secret"))
  }
})

test("refresh is single-flight and preserves an omitted refresh token", async () => {
  let calls = 0
  const refresh = singleFlightRefresh(async () => {
    calls++
    return Response.json({ access_token: "new-access", expires_in: 3600 })
  })
  const old = { type: "oauth" as const, methodID: "pkce" as never, access: "old", refresh: "fake-refresh", expires: 0 }
  const credentials = await Promise.all([refresh(old), refresh(old), refresh(old)])
  assert.equal(calls, 1)
  assert.equal(credentials[0].refresh, "fake-refresh")
  assert.equal(credentials[0].access, "new-access")
})

test("login cancellation rejects and closes the callback listener", async () => {
  const login = await beginLogin({ ports: [0] })
  login.cancel()
  await assert.rejects(login.callback, /cancelled/)
})

test("login deadline closes the listener and rejects without tokens", async () => {
  const login = await beginLogin({ ports: [0], timeoutMs: 20 })
  await assert.rejects(login.callback, /timed out/)
})

test("refresh accepts rotation, rejects invalid credentials, and permits retry", async () => {
  const old = { type: "oauth" as const, methodID: "pkce" as never, access: "old", refresh: "fake-refresh", expires: 0 }
  let calls = 0
  const refresh = singleFlightRefresh(async () => {
    calls++
    return Response.json(calls === 1
      ? { access_token: "invalid token", expires_in: 3600 }
      : { access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 })
  })
  await assert.rejects(refresh(old), /token request failed/)
  assert.equal((await refresh(old)).refresh, "rotated-refresh")
  assert.equal(calls, 2)
})
