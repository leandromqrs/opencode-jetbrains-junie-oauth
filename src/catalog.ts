import { ACCOUNT_ROUTING_HEADERS, UPSTREAM } from "./transport.js"

export const vendors = ["anthropic", "openai", "google", "grok"] as const
export type Vendor = typeof vendors[number]
export interface ListedModel { id: string; context?: number; output?: number }
export interface ListingResult { vendor: Vendor; status?: number; error?: string; models: ListedModel[] }
export interface Catalog { fetchedAt: number; routes: ListingResult[] }
const safeID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}$/
const positive = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined

export function parseListing(vendor: Vendor, payload: unknown): ListedModel[] {
  if (!payload || typeof payload !== "object") throw new Error("Unrecognized model listing format.")
  const record = payload as Record<string, unknown>
  const entries = vendor === "google" ? record.models : record.data
  if (!Array.isArray(entries) || entries.length > 2000) throw new Error("Unrecognized model listing format.")
  const models = new Map<string, ListedModel>()
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    const id = vendor === "google" && typeof item.name === "string" ? item.name.replace(/^models\//, "") : item.id
    if (typeof id !== "string" || !safeID.test(id)) continue
    const context = positive(item.inputTokenLimit)
    const output = positive(item.outputTokenLimit)
    models.set(id, { id, ...(context ? { context } : {}), ...(output ? { output } : {}) })
  }
  return [...models.values()]
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Empty listing.")
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new Error("Oversized listing.")
      chunks.push(value)
    }
    signal.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function discoverCatalog(access: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Catalog> {
  const routes: ListingResult[] = []
  for (const vendor of vendors) {
    const timeout = AbortSignal.timeout(15_000)
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout
    const path = vendor === "google" ? "/llm/google/v1/models" : "/v1/models"
    let status: number | undefined
    try {
      bounded.throwIfAborted()
      const response = await fetcher(`${UPSTREAM}${path}`, {
        method: "GET", redirect: "error", signal: bounded,
        headers: { ...ACCOUNT_ROUTING_HEADERS, Authorization: `Bearer ${access}`, "X-LLM-Model": vendor, "X-Keep-Path": "true", Accept: "application/json", "anthropic-version": "2023-06-01" },
      })
      status = response.status
      if (!response.ok) { await response.body?.cancel(); routes.push({ vendor, status, models: [] }); continue }
      const models = parseListing(vendor, await boundedJSON(response, bounded))
      routes.push({ vendor, status, models })
    } catch {
      if (signal?.aborted) throw new Error("JetBrains discovery cancelled.")
      routes.push({ vendor, ...(status ? { status } : {}), error: "Metadata request failed or returned an unsupported listing.", models: [] })
    }
  }
  return { fetchedAt: Date.now(), routes }
}
