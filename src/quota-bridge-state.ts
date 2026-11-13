import type { JunieBalance } from "./quota.js"
import type { QuotaBridge } from "./quota-bridge.js"

export interface QuotaBridgeLease {
  getAccount(signal: AbortSignal): Promise<string | undefined>
  getBalance(signal: AbortSignal): Promise<JunieBalance>
  stateDirectory?: string
  workspaceRoots?: readonly string[]
}

export interface QuotaBridgeStatus {
  enabled: boolean
  management: "plugin" | "external"
  running: boolean | null
  url?: string
  diagnostic?: "missing-account" | "ambiguous-account" | "incompatible-config" | "start-failed"
}

export interface SharedQuotaBridge {
  port: number
  apiKeyEnv: string
  shared: boolean
  stateDirectory?: string
  account: string
  token: string
  owned: boolean
  blocked: boolean
  bridge: QuotaBridge
  leases: Map<symbol, QuotaBridgeLease>
  statuses: Set<QuotaBridgeStatus>
}

interface Registry { entry?: SharedQuotaBridge; queue: Promise<void> }
const registryKey = Symbol.for("opencode-jetbrains-junie-oauth.quota-bridge.v1")

export function quotaBridgeRegistry(): Registry {
  const root = globalThis as typeof globalThis & { [registryKey]?: Registry }
  return root[registryKey] ??= { queue: Promise.resolve() }
}

export function serializeQuotaBridge<T>(registry: Registry, operation: () => Promise<T>): Promise<T> {
  const next = registry.queue.then(operation, operation)
  registry.queue = next.then(() => {}, () => {})
  return next
}
