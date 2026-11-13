import { Effect, type Scope } from "effect"
import { createHmac, randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { startQuotaBridge, type QuotaBridge } from "./quota-bridge.js"
import { startSharedQuotaBridge } from "./quota-bridge-shared.js"
import { prepareQuotaBridgeState } from "./quota-bridge-storage.js"
import { quotaBridgeRegistry, serializeQuotaBridge, type QuotaBridgeLease, type QuotaBridgeStatus, type SharedQuotaBridge } from "./quota-bridge-state.js"
import { withCancellation } from "./cancellation.js"

export interface QuotaBridgeConfig { port: number; apiKeyEnv: string; autoKey?: boolean; shared?: boolean }

export function parseQuotaBridge(value: unknown): QuotaBridgeConfig | undefined {
  if (value === undefined || value === false) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JetBrains quotaBridge requires a port and optional apiKeyEnv, autoKey and shared.")
  const { port, apiKeyEnv = "JUNIE_QUOTA_ADAPTER_KEY", autoKey, shared } = value as Record<string, unknown>
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535 || typeof apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error("JetBrains quotaBridge requires port 1–65535 and a valid apiKeyEnv name.")
  if (autoKey !== undefined && typeof autoKey !== "boolean") throw new Error("JetBrains quotaBridge autoKey must be boolean.")
  if (shared !== undefined && typeof shared !== "boolean" || shared === true && autoKey !== true) throw new Error("Shared Junie bridge requires autoKey.")
  return { port: Number(port), apiKeyEnv, ...(autoKey !== undefined ? { autoKey } : {}), ...(shared !== undefined ? { shared } : {}) }
}

async function accountOf(lease: QuotaBridgeLease, signal: AbortSignal): Promise<string | undefined> {
  const account = await withCancellation(lease.getAccount(signal), signal)
  if (account !== undefined && (typeof account !== "string" || account.length < 1 || account.length > 1024)) throw new Error("Junie account unavailable.")
  return account
}

function block(entry: SharedQuotaBridge, diagnostic: "ambiguous-account" | "missing-account"): void {
  entry.blocked = true
  if (entry.owned && process.env[entry.apiKeyEnv] === entry.token) delete process.env[entry.apiKeyEnv]
  for (const status of entry.statuses) Object.assign(status, { running: false, diagnostic })
}

export function acquireQuotaBridge(config: QuotaBridgeConfig | undefined, dependencies: QuotaBridgeLease): Effect.Effect<QuotaBridgeStatus, never, Scope.Scope> {
  const status: QuotaBridgeStatus = { enabled: !!config, management: config?.autoKey ? "plugin" : "external", running: config?.autoKey ? false : null, ...(config ? { url: `http://127.0.0.1:${config.port}/quota` } : {}) }
  if (!config?.autoKey) return Effect.succeed(status)
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const registry = quotaBridgeRegistry()
      try {
        return await serializeQuotaBridge(registry, async () => {
          const account = await accountOf(dependencies, AbortSignal.timeout(3000))
          if (!account) {
            const existing = registry.entry
            if (existing && existing.port === config.port && existing.apiKeyEnv === config.apiKeyEnv) block(existing, "missing-account")
            return { status: Object.assign(status, { diagnostic: "missing-account" as const }) }
          }
          const id = Symbol()
          const roots = [...(dependencies.workspaceRoots ?? []), ...(resolve(process.cwd()) === resolve(homedir()) ? [] : [process.cwd()])]
          const existing = registry.entry
          if (existing) {
            if (existing.port !== config.port || existing.apiKeyEnv !== config.apiKeyEnv || existing.shared !== !!config.shared || dependencies.stateDirectory !== undefined && resolve(dependencies.stateDirectory) !== existing.stateDirectory) return { status: Object.assign(status, { diagnostic: "incompatible-config" as const }) }
            if (existing.account !== account || existing.blocked) {
              block(existing, "ambiguous-account")
              return { status: Object.assign(status, { diagnostic: "ambiguous-account" as const }) }
            }
            if (process.env[config.apiKeyEnv] !== existing.token) return { status: Object.assign(status, { diagnostic: "incompatible-config" as const }) }
            if (config.shared) {
              const state = await prepareQuotaBridgeState({ stateDirectory: existing.stateDirectory, workspaceRoots: roots })
              if (createHmac("sha256", state.token).update(`junie-quota-bearer-v1:${config.port}:${account}`).digest("hex") !== existing.token) throw new Error("Junie bridge state changed.")
            }
            existing.leases.set(id, dependencies)
            existing.statuses.add(status)
            Object.assign(status, { running: true })
            return { status, registry, entry: existing, id }
          }
          const state = config.shared ? await prepareQuotaBridgeState({ stateDirectory: dependencies.stateDirectory, workspaceRoots: roots }) : undefined
          // Different active accounts must not share a bearer, even across processes.
          const token = createHmac("sha256", state?.token ?? randomBytes(32)).update(`junie-quota-bearer-v1:${config.port}:${account}`).digest("hex")
          const previous = process.env[config.apiKeyEnv]
          if (previous !== undefined && previous !== token) return { status: Object.assign(status, { diagnostic: "incompatible-config" as const }) }
          const leases = new Map<symbol, QuotaBridgeLease>([[id, dependencies]])
          const statuses = new Set([status])
          let entry: SharedQuotaBridge | undefined
          let bridge: QuotaBridge | undefined
          const getBalance: QuotaBridgeLease["getBalance"] = async signal => {
            if (!entry || entry.blocked || !leases.size) throw new Error("Junie bridge unavailable.")
            const snapshot = [...leases.entries()]
            const current = snapshot.map(([, lease]) => lease)
            const check = async () => {
              if (snapshot.some(([id, lease]) => leases.get(id) !== lease)) throw new Error("Junie bridge location changed.")
              const accounts = await Promise.all(current.map(lease => accountOf(lease, signal)))
              if (accounts.some(value => value !== account)) {
                block(entry!, accounts.some(value => !value) ? "missing-account" : "ambiguous-account")
                throw new Error("Junie bridge account changed.")
              }
            }
            await check()
            const balance = await withCancellation(current[0]!.getBalance(signal), signal)
            await check()
            if (entry.blocked) throw new Error("Junie bridge unavailable.")
            return balance
          }
          try {
            bridge = await (config.shared ? startSharedQuotaBridge : startQuotaBridge)({ port: config.port, token, getBalance, checkAccount: async (signal: AbortSignal) => {
              if (!entry) return true
              if (entry.blocked) return false
              try {
                const accounts = await Promise.all([...leases.values()].map(lease => accountOf(lease, signal)))
                if (accounts.some(value => value !== account)) {
                  block(entry, accounts.some(value => !value) ? "missing-account" : "ambiguous-account")
                  return false
                }
                return true
              } catch { block(entry, "missing-account"); return false }
            }, onAvailability: (available: boolean) => {
              if (!entry || entry.blocked) return
              if (entry.owned) {
                if (!available && process.env[config.apiKeyEnv] === token) delete process.env[config.apiKeyEnv]
                if (available && process.env[config.apiKeyEnv] === undefined) process.env[config.apiKeyEnv] = token
              }
              for (const current of statuses) current.running = available && process.env[config.apiKeyEnv] === token
            } })
            // Matching inherited bearers must remain revocable on account changes.
            entry = { port: config.port, apiKeyEnv: config.apiKeyEnv, shared: !!config.shared, stateDirectory: state?.directory, account, token, owned: true, blocked: false, bridge, leases, statuses }
            if (entry.owned) process.env[config.apiKeyEnv] = token
            registry.entry = entry
            Object.assign(status, { running: true })
            return { status, registry, entry, id }
          } catch {
            await bridge?.close()
            if (registry.entry === entry) delete registry.entry
            if (process.env[config.apiKeyEnv] === token) delete process.env[config.apiKeyEnv]
            return { status: Object.assign(status, { diagnostic: "start-failed" as const }) }
          }
        })
      } catch { return { status: Object.assign(status, { diagnostic: "start-failed" as const }) } }
    }),
    acquired => Effect.promise(async () => {
      if (!("registry" in acquired) || !acquired.registry || !acquired.entry || !acquired.id) return
      const { registry, entry, id } = acquired
      await serializeQuotaBridge(registry, async () => {
        if (registry.entry !== entry) return
        entry.leases.delete(id)
        entry.statuses.delete(acquired.status)
        acquired.status.running = false
        if (entry.leases.size) return
        try { await entry.bridge.close() }
        finally {
          if (entry.owned && process.env[entry.apiKeyEnv] === entry.token) delete process.env[entry.apiKeyEnv]
          delete registry.entry
        }
      })
    }),
  ).pipe(Effect.map(acquired => acquired.status))
}
