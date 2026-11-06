import { withCancellation } from "./cancellation.js"

const BALANCE_URL = "https://ingrazzio-cloud-prod.labs.jb.gg/auth/test"
const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 65_536
const licenses = new Set(["SEAT", "GZL", "NONE", "TRIAL", "AIP", "AIPU", "AIF", "JUNP"])
const routingHeaderNames = new Set([
  "x-forced-license", "x-forced-licence", "x-forced-license-free", "x-forced-licence-free",
  "x-accept-eap-license", "x-accept-release-license",
])

export type JunieBalanceUnit = "credits" | "USD"
export type JunieBalanceUnavailableReason =
  | "inactive" | "unsupported-license" | "unsupported-unit" | "missing-balance"
  | "invalid-response" | "invalid-context" | "invalid-credentials"
  | "unauthorized" | "rate-limited" | "http-error" | "network-error"
  | "body-too-large" | "timeout" | "cancelled"

type BalanceMetadata = { license?: string; observedAt: string }
export type JunieBalance = BalanceMetadata & (
  | { state: "available"; amount: number; unit: JunieBalanceUnit }
  | { state: "unavailable"; reason: JunieBalanceUnavailableReason }
)

export interface JunieBalanceOptions {
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  routingHeaders?: Readonly<Record<string, string>>
}

export interface JunieQuotaV1 {
  version: "quota-v1"
  entries: [{
    kind: "value"
    name: "balance"
    label: "Junie balance"
    resultType: "balance" | "status"
    value: string
    observedAtIso: string
  }]
}

function unavailable(reason: JunieBalanceUnavailableReason, metadata: BalanceMetadata = { observedAt: new Date().toISOString() }): JunieBalance {
  return { state: "unavailable", reason, ...metadata }
}

export function parseJunieBalance(payload: unknown, observedAt = new Date().toISOString()): JunieBalance {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unavailable("invalid-response", { observedAt })
  const data = payload as Record<string, unknown>
  const metadata: BalanceMetadata = { observedAt }
  if (typeof data.licenseType === "string" && licenses.has(data.licenseType)) metadata.license = data.licenseType
  if (data.active !== undefined && data.active !== null && typeof data.active !== "boolean") return unavailable("invalid-response", metadata)
  if (data.active === false || data.licenseType === "NONE") return unavailable("inactive", metadata)
  if (data.licenseType === "GZL") return unavailable("unsupported-license", metadata)
  if (typeof data.balanceLeft !== "number" || !Number.isFinite(data.balanceLeft) || data.balanceLeft < 0 || data.balanceLeft > Number.MAX_SAFE_INTEGER) return unavailable("missing-balance", metadata)
  if (data.balanceUnit === "USD") return { state: "available", amount: data.balanceLeft, unit: "USD", ...metadata }
  // Junie 3959.5 FormatCostKt defaults a missing unit to credits at 100000 raw units per credit.
  if (data.balanceUnit !== undefined && data.balanceUnit !== null && data.balanceUnit !== "CREDIT" && data.balanceUnit !== "CREDITS") return unavailable("unsupported-unit", metadata)
  return { state: "available", amount: data.balanceLeft / 100_000, unit: "credits", ...metadata }
}

export function formatJunieBalance(balance: JunieBalance): string {
  if (balance.state === "unavailable") return "Unavailable"
  const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false }).format(balance.amount)
  return `${amount} ${balance.unit}`
}

export function toJunieQuotaV1(balance: JunieBalance): JunieQuotaV1 {
  return { version: "quota-v1", entries: [{
    kind: "value", name: "balance", label: "Junie balance",
    resultType: balance.state === "available" ? "balance" : "status",
    value: formatJunieBalance(balance), observedAtIso: balance.observedAt,
  }] }
}

class QuotaFailure extends Error {
  constructor(readonly reason: JunieBalanceUnavailableReason) { super(reason) }
}

function requestHeaders(accessToken: string, routingHeaders: JunieBalanceOptions["routingHeaders"]): Headers {
  const headers = new Headers({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" })
  try {
    for (const [name, value] of Object.entries(routingHeaders ?? {})) {
      if (!routingHeaderNames.has(name.toLowerCase()) || typeof value !== "string" || value.length > 512 || /[\r\n]/.test(value)) throw new QuotaFailure("invalid-context")
      headers.set(name, value)
    }
  } catch { throw new QuotaFailure("invalid-context") }
  return headers
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

async function readMetadata(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length")
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    cancelBody(response)
    throw new QuotaFailure("body-too-large")
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (!contentType || !(contentType === "application/json" || (contentType.startsWith("application/") && contentType.endsWith("+json"))) || !response.body) {
    cancelBody(response)
    throw new QuotaFailure("invalid-response")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await withCancellation(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) throw new QuotaFailure("body-too-large")
      chunks.push(value)
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new QuotaFailure("invalid-response") }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function getJunieBalance(accessToken: string, options: JunieBalanceOptions = {}): Promise<JunieBalance> {
  if (options.signal?.aborted) return unavailable("cancelled")
  if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(accessToken)) return unavailable("invalid-credentials")
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timeout = setTimeout(onAbort, TIMEOUT_MS)
  try {
    const headers = requestHeaders(accessToken, options.routingHeaders)
    const pending = (options.fetch ?? globalThis.fetch)(BALANCE_URL, { method: "GET", headers, redirect: "error", signal: controller.signal }).then(response => {
      if (controller.signal.aborted) {
        cancelBody(response)
        throw new Error("Cancelled")
      }
      return response
    })
    const response = await withCancellation(pending, controller.signal)
    if (!response.ok || response.redirected) {
      cancelBody(response)
      return unavailable(response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate-limited" : "http-error")
    }
    return parseJunieBalance(await readMetadata(response, controller.signal))
  } catch (error) {
    if (controller.signal.aborted) return unavailable(options.signal?.aborted ? "cancelled" : "timeout")
    return unavailable(error instanceof QuotaFailure ? error.reason : "network-error")
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
