import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service, type Endpoint } from "@opencode/client/service"
import { startQuotaBridge, type QuotaBridge } from "./quota-bridge.js"
import type { JunieBalance } from "./quota.js"
import { withCancellation } from "./cancellation.js"

const quotaRPC = {
  id: "jetbrains-junie",
  methods: { quota: { input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: true } } },
  events: {},
} as const

export interface QuotaAdapterOptions {
  location: string
  token: string
  port?: number
  signal?: AbortSignal
  requestTimeoutMs?: number
  discover?: () => Promise<Endpoint | undefined>
  fetch?: typeof globalThis.fetch
}

function validLocation(location: string): boolean {
  return typeof location === "string" && location.length <= 4_096 && isAbsolute(location) && !/[\x00-\x1f\x7f]/.test(location)
}

function boundedRpcFetch(endpoint: Endpoint, fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  const base = new URL(endpoint.url)
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Quota service unavailable.")
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" })
    const url = new URL(request.url)
    if (url.origin !== base.origin || url.pathname !== "/api/rpc/jetbrains-junie/quota" || request.method !== "POST") throw new Error("Quota service unavailable.")
    request.signal.throwIfAborted()
    const pending = fetcher(request).then(response => {
      if (request.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        throw new Error("Quota service unavailable.")
      }
      return response
    })
    const response = await withCancellation(pending, request.signal, "Quota service unavailable.")
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > 65_536) {
      void response.body?.cancel().catch(() => {})
      throw new Error("Quota service unavailable.")
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await withCancellation(reader.read(), request.signal, "Quota service unavailable.")
        if (done) break
        size += value.byteLength
        if (size > 65_536) throw new Error("Quota service unavailable.")
        if (value.byteLength) chunks.push(value)
      }
      return new Response(Buffer.concat(chunks), { headers: { "Content-Type": "application/json" } })
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

function publicBalance(value: unknown): JunieBalance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Quota service unavailable.")
  const data = value as Record<string, unknown>
  if (typeof data.observedAt !== "string" || data.observedAt.length > 32 || new Date(data.observedAt).toISOString() !== data.observedAt) throw new Error("Quota service unavailable.")
  if (data.state === "unavailable") return { state: "unavailable", reason: "network-error", observedAt: data.observedAt }
  if (data.state !== "available" || typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount < 0 || data.amount > Number.MAX_SAFE_INTEGER || (data.unit !== "credits" && data.unit !== "USD")) throw new Error("Quota service unavailable.")
  return { state: "available", amount: data.amount, unit: data.unit, observedAt: data.observedAt }
}

export async function startQuotaAdapter(options: QuotaAdapterOptions): Promise<QuotaBridge> {
  if (!validLocation(options.location)) throw new Error("Invalid quota adapter configuration.")
  const location = { directory: resolve(options.location) }
  return startQuotaBridge({
    port: options.port ?? 62_365,
    token: options.token,
    signal: options.signal,
    requestTimeoutMs: options.requestTimeoutMs,
    getBalance: async signal => {
      try {
        signal.throwIfAborted()
        // Discover on every authenticated request so a service replacement cannot leave stale credentials or balance.
        const endpoint = await withCancellation((options.discover ?? Service.discover)(), signal, "Quota service unavailable.")
        if (!endpoint) throw new Error("Quota service unavailable.")
        signal.throwIfAborted()
        const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint), fetch: boundedRpcFetch(endpoint, options.fetch ?? globalThis.fetch) })
        return publicBalance(await client.rpc(quotaRPC).quota({}, { location, signal }))
      } catch { throw new Error("Quota service unavailable.") }
    },
  })
}

export function quotaAdapterConfig(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): { location: string; port: number; token: string } {
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!["--location", "--port", "--api-key-env"].includes(name) || !value || flags.has(name)) throw new Error("Invalid quota adapter configuration.")
    flags.set(name, value)
  }
  const location = flags.get("--location")
  const port = Number(flags.get("--port") ?? "62365")
  const keyEnv = flags.get("--api-key-env") ?? "JUNIE_QUOTA_ADAPTER_KEY"
  if (!location || !validLocation(location) || !Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Z][A-Z0-9_]{0,127}$/.test(keyEnv)) throw new Error("Invalid quota adapter configuration.")
  const token = env[keyEnv]?.trim()
  if (!token || !/^[\x21-\x7e]{32,512}$/.test(token)) throw new Error("Invalid quota adapter configuration.")
  return { location: resolve(location), port, token }
}

async function main(): Promise<void> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    const adapter = await startQuotaAdapter({ ...quotaAdapterConfig(process.argv.slice(2)), signal: controller.signal })
    process.stdout.write("Junie quota adapter is ready.\n")
    try {
      await new Promise<void>(resolve => {
        if (controller.signal.aborted) resolve()
        else controller.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    } finally { await adapter.close() }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Quota adapter failed; check its configuration, key environment and listener port.\n")
    process.exitCode = 1
  })
}
