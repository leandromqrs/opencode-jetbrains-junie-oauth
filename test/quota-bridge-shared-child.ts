import { Effect, Exit, Scope } from "effect"
import { acquireQuotaBridge } from "../src/quota-bridge-plugin.js"

const env = "JUNIE_SYNTHETIC_CHILD_BRIDGE_KEY"
let scope: Scope.Closeable | undefined
let url = ""
let calls = 0
let account = "credential:fixture"
let bridgeStatus: { running: boolean | null; diagnostic?: string } | undefined

process.on("message", async (message: { action: string; port: number; directory: string; account?: string }) => {
  try {
    if (message.action === "start") {
      scope = await Effect.runPromise(Scope.make())
      account = message.account ?? account
      const status = await Effect.runPromise(acquireQuotaBridge({ port: message.port, apiKeyEnv: env, autoKey: true, shared: true }, {
        stateDirectory: message.directory, workspaceRoots: [], getAccount: async () => account,
        getBalance: async () => { calls++; return { state: "available", amount: 9.5, unit: "credits", observedAt: "2026-11-11T00:00:00.000Z" } },
      }).pipe(Scope.provide(scope)))
      bridgeStatus = status
      url = status.url ?? ""
      process.send?.({ running: status.running, diagnostic: status.diagnostic, calls, keyPresent: !!process.env[env] })
    } else if (message.action === "query") {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env[env]}` }, signal: AbortSignal.timeout(1000) }).catch(() => undefined)
      process.send?.({ ok: response?.status === 200 })
    } else if (message.action === "change-account") {
      account = message.account ?? "credential:other"
      process.send?.({ changed: true })
    } else if (message.action === "status") {
      process.send?.({ running: bridgeStatus?.running, diagnostic: bridgeStatus?.diagnostic, keyPresent: !!process.env[env] })
    } else if (message.action === "stop") {
      if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
      process.send?.({ keyPresent: !!process.env[env] })
    }
  } catch { process.send?.({ failed: true }) }
})
