import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { Effect, Exit, Scope } from "effect"
import { acquireQuotaBridge } from "../src/quota-bridge-plugin.js"

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

test("managed bridge starts without upstream calls, survives a location disposal, and restores its private key after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junie-bridge-"))
  const env = "JUNIE_TEST_MANAGED_BRIDGE_KEY"
  const previous = process.env[env]
  delete process.env[env]
  const port = await freePort()
  const config = { port, apiKeyEnv: env, autoKey: true, shared: true }
  let calls = 0
  const dependencies = {
    stateDirectory: join(directory, "state"), workspaceRoots: [join(directory, "workspace")],
    getAccount: async () => "credential:synthetic-account",
    getBalance: async () => { calls++; return { state: "available" as const, amount: 12.3, unit: "credits" as const, observedAt: "2026-11-11T00:00:00.000Z" } },
  }
  const first = await Effect.runPromise(Scope.make())
  const second = await Effect.runPromise(Scope.make())
  const restarted = await Effect.runPromise(Scope.make())
  try {
    const status = await Effect.runPromise(acquireQuotaBridge(config, dependencies).pipe(Scope.provide(first)))
    assert.equal(status.running, true)
    assert.equal(status.management, "plugin")
    assert.equal(calls, 0)
    const key = process.env[env]
    assert.ok(key)
    assert.equal((await fetch(status.url!)).status, 401)
    await Effect.runPromise(acquireQuotaBridge(config, dependencies).pipe(Scope.provide(second)))
    await Effect.runPromise(Scope.close(first, Exit.void))
    assert.equal((await fetch(status.url!, { headers: { Authorization: `Bearer ${key}` } })).status, 200)
    assert.equal(calls, 1)
    await Effect.runPromise(Scope.close(second, Exit.void))
    assert.equal(process.env[env], undefined)
    const restored = await Effect.runPromise(acquireQuotaBridge(config, dependencies).pipe(Scope.provide(restarted)))
    assert.equal(restored.running, true)
    assert.equal(process.env[env], key)
    assert.equal(calls, 1)
  } finally {
    await Effect.runPromise(Scope.close(first, Exit.void))
    await Effect.runPromise(Scope.close(second, Exit.void))
    await Effect.runPromise(Scope.close(restarted, Exit.void))
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test("ambiguous local accounts fail closed and revoke the process-owned consumer key", async () => {
  const env = "JUNIE_TEST_AMBIGUOUS_BRIDGE_KEY"
  const port = await freePort()
  let account = "credential:one"
  let calls = 0
  const scopes = await Promise.all([Effect.runPromise(Scope.make()), Effect.runPromise(Scope.make())])
  const config = { port, apiKeyEnv: env, autoKey: true }
  const dependencies = {
    getAccount: async () => account,
    getBalance: async () => { calls++; return { state: "unavailable" as const, reason: "invalid-context" as const, observedAt: "2026-11-11T00:00:00.000Z" } },
  }
  try {
    const first = await Effect.runPromise(acquireQuotaBridge(config, dependencies).pipe(Scope.provide(scopes[0]!)))
    const key = process.env[env]
    account = "credential:two"
    const second = await Effect.runPromise(acquireQuotaBridge(config, dependencies).pipe(Scope.provide(scopes[1]!)))
    assert.equal(second.diagnostic, "ambiguous-account")
    assert.equal(first.running, false)
    assert.equal(process.env[env], undefined)
    assert.equal((await fetch(first.url!, { headers: { Authorization: `Bearer ${key}` } })).status, 503)
    assert.equal(calls, 0)
  } finally { for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("an account switch during a balance read cannot publish the previous account's result", async () => {
  const env = "JUNIE_TEST_SWITCH_BRIDGE_KEY"
  const scope = await Effect.runPromise(Scope.make())
  let account = "credential:one"
  const status = await Effect.runPromise(acquireQuotaBridge({ port: await freePort(), apiKeyEnv: env, autoKey: true }, {
    getAccount: async () => account,
    getBalance: async () => { account = "credential:two"; return { state: "available", amount: 7, unit: "credits", observedAt: "2026-11-11T00:00:00.000Z" } },
  }).pipe(Scope.provide(scope)))
  try {
    assert.equal((await fetch(status.url!, { headers: { Authorization: `Bearer ${process.env[env]}` } })).status, 503)
    assert.equal(status.diagnostic, "ambiguous-account")
    assert.equal(process.env[env], undefined)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})
