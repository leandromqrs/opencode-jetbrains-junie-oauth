import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import plugin from "../src/index.js"
import { memoryStorage } from "./discovery-support.js"

const label = "Junie by Jetbrains"

test("native quota pilot is opt-in and preserves the legacy RPC", async () => {
  for (const [option, expected] of [[undefined, false], [false, false], ["true", false], [true, true]] as const) {
    const registration = { dispose: Effect.void }
    const rpcIDs: string[] = []
    const ctx = {
      options: { quotaRpc: option },
      storage: memoryStorage().storage,
      event: { subscribe: () => Stream.empty },
      rpc: { register: ({ id }: { id: string }) => Effect.sync(() => { rpcIDs.push(id); return registration }) },
      provider: { transform: () => Effect.succeed(registration) },
      integration: { transform: () => Effect.succeed(registration), connection: { active: () => Effect.succeed(undefined) } },
      session: { hook: () => Effect.succeed(registration) },
    }
    await Effect.runPromise(Effect.scoped(plugin.effect(ctx as unknown as Plugin.Context)))
    assert.equal(rpcIDs.includes("jetbrains-junie"), true)
    assert.equal(rpcIDs.includes("jetbrains.quota"), expected)
  }
})

test("native quota reads the active balance without retaining it across account changes", { timeout: 3000 }, async t => {
  const registration = { dispose: Effect.void }
  let status: (() => Effect.Effect<unknown>) | undefined
  let account: string | undefined = "first"
  let requests = 0
  let fail = false
  const ctx = {
    options: { quotaRpc: true },
    storage: memoryStorage().storage,
    event: { subscribe: () => Stream.empty },
    rpc: {
      register: ({ id }: { id: string }, handlers: { status: () => Effect.Effect<unknown> }) => Effect.sync(() => {
        if (id === "jetbrains.quota") status = handlers.status
        return registration
      }),
    },
    provider: { transform: () => Effect.succeed(registration) },
    integration: {
      transform: () => Effect.succeed(registration),
      connection: {
        active: () => Effect.sync(() => account ? { type: "credential", id: account, method: "oauth" } : undefined),
        resolve: (connection: { id: string }) => Effect.succeed({ type: "oauth", access: `synthetic-${connection.id}` }),
      },
    },
    session: { hook: () => Effect.succeed(registration) },
  }
  let finishRead!: (response: Response) => void
  const pendingRead = new Promise<Response>(resolve => { finishRead = resolve })
  let startRead!: () => void
  const readStarted = new Promise<void>(resolve => { startRead = resolve })
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /^https:\/\/ingrazzio-cloud-prod\.labs\.jb\.gg\/auth\/test$/)
    requests++
    if (fail) return new Response(null, { status: 503 })
    const first = new Headers(init?.headers).get("authorization") === "Bearer synthetic-first"
    if (first && requests === 2) {
      startRead()
      return pendingRead
    }
    return Response.json({ active: true, licenseType: "AIP", balanceUnit: "CREDITS", balanceLeft: first ? 1989000 : 0, username: "private" })
  })

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* plugin.effect(ctx as unknown as Plugin.Context)
    assert.equal(requests, 0)
    assert.ok(status)
    assert.deepEqual(yield* status(), { label, groups: [{ title: "Balance", value: "19.89 credits" }] })

    const staleRead = Effect.runPromise(status())
    yield* Effect.promise(() => readStarted)
    account = "second"
    finishRead(Response.json({ active: true, licenseType: "AIP", balanceUnit: "CREDITS", balanceLeft: 1989000 }))
    assert.deepEqual(yield* Effect.promise(() => staleRead), { label, groups: [] })
    assert.deepEqual(yield* status(), { label, groups: [{ title: "Balance", value: "0.00 credits" }] })

    fail = true
    assert.deepEqual(yield* status(), { label, groups: [] })
    account = undefined
    assert.deepEqual(yield* status(), { label, groups: [] })
    assert.equal(requests, 4)
  })))
})
