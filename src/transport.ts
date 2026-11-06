export const UPSTREAM = "https://ingrazzio-cloud-prod.labs.jb.gg"
import type { ModelBinding } from "./inventory.js"

export const ACCOUNT_ROUTING_HEADERS = { "X-Accept-EAP-License": "false" } as const

const allowedFields = new Set([
  "model", "messages", "max_tokens", "system", "metadata", "stop_sequences",
  "stream", "temperature", "top_p", "top_k", "tools", "tool_choice", "thinking", "output_config",
])

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error("Missing model request body.")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 8 * 1024 * 1024) throw new Error()
      chunks.push(value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    await reader.cancel().catch(() => {})
    throw new Error("Invalid or oversized JetBrains model request.")
  } finally { reader.releaseLock() }
}

export async function prepareRequest(request: Request, access: string, models: readonly (ModelBinding | string)[], timeoutMs: number): Promise<Request> {
  const url = new URL(request.url)
  if (url.origin !== UPSTREAM || url.username || url.password || request.method !== "POST") {
    throw new Error("JetBrains provider blocked an unexpected destination or route.")
  }
  request.signal.throwIfAborted()
  const payload = await readBody(request)
  const binding = models.map(model => typeof model === "string" ? { id: model, wireID: model, vendor: "anthropic" as const } : model).find(model => {
    if (model.vendor === "google") return url.pathname === `/v1beta1/projects/jetbrains-grazie/locations/global/publishers/google/models/${model.wireID}:streamGenerateContent` && url.search === "?alt=sse"
    return payload.model === model.wireID && url.pathname === (model.vendor === "anthropic" ? "/v1/messages" : "/v1/responses") && !url.search
  })
  if (!binding) throw new Error("JetBrains model or route is not explicitly configured.")
  const body = binding.vendor === "anthropic" ? Object.fromEntries(Object.entries(payload).filter(([key]) => allowedFields.has(key))) : payload
  if ("service_tier" in payload) throw new Error("JetBrains service tier overrides and Eco are unsupported.")
  if (Array.isArray(body.system)) {
    body.system = body.system.map((block: unknown) => {
      if (!block || typeof block !== "object" || !("cache_control" in block)) return block
      const { cache_control, ...rest } = block as Record<string, unknown>
      if (!cache_control || typeof cache_control !== "object" || !("type" in cache_control)) return rest
      return { ...rest, cache_control: { type: cache_control.type } }
    })
  }
  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Grazie-Agent": JSON.stringify({ name: "opencode-jetbrains-junie-oauth", version: "0.1.0" }),
    "X-LLM-Model": binding.vendor,
    "X-Keep-Path": "true",
    "Openai-Version": "2020-11-07",
    ...ACCOUNT_ROUTING_HEADERS,
    "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01",
  })
  return new Request(url, {
    method: "POST", headers, body: JSON.stringify(body), redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
  })
}

export async function sanitizeResponse(response: Response): Promise<Response> {
  if (response.ok) return response
  await response.body?.cancel().catch(() => {})
  return Response.json({ type: "error", error: {
    type: "jetbrains_upstream_error", message: `JetBrains upstream returned HTTP ${response.status}; check sign-in, entitlement, or rate limits.`,
  } }, { status: response.status })
}
