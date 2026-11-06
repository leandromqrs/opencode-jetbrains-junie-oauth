import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Server, type RequestListener } from "node:http"
import { Credential, Integration } from "@opencode/plugin"

export const TOKEN_URL = "https://oauth.account.jetbrains.com/oauth2/token"
export const METHOD_ID = Integration.MethodID.make("pkce")
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function exchangeToken(form: URLSearchParams, fetcher: Fetch = fetch, previousRefresh?: string, signal?: AbortSignal): Promise<Credential.OAuth> {
  try {
    const response = await fetcher(TOKEN_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("OAuth token request failed")
    }
    const value: unknown = await response.json()
    if (!value || typeof value !== "object") throw new Error()
    const data = value as Record<string, unknown>
    const refresh = data.refresh_token ?? previousRefresh
    if (typeof data.access_token !== "string" || !data.access_token || /\s/.test(data.access_token)
      || typeof refresh !== "string" || !refresh || /\s/.test(refresh)
      || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)
      || data.expires_in <= 0 || data.expires_in > 31_536_000) throw new Error()
    const lifetime = data.expires_in * 1000
    return {
      type: "oauth", methodID: METHOD_ID, access: data.access_token, refresh,
      expires: Math.floor(Date.now() + lifetime - Math.min(60_000, lifetime / 10)),
    }
  } catch {
    throw new Error("JetBrains OAuth token request failed; sign in again or retry later.")
  }
}

export function singleFlightRefresh(fetcher: Fetch = fetch) {
  const pending = new Map<string, Promise<Credential.OAuth>>()
  return (credential: Credential.OAuth): Promise<Credential.OAuth> => {
    const existing = pending.get(credential.refresh)
    if (existing) return existing
    const request = exchangeToken(new URLSearchParams({
      grant_type: "refresh_token", refresh_token: credential.refresh, client_id: "junie-cli",
    }), fetcher, credential.refresh).finally(() => pending.delete(credential.refresh))
    pending.set(credential.refresh, request)
    return request
  }
}

export interface Login {
  url: string
  expiresAt: number
  callback: Promise<Credential.OAuth>
  cancel(): void
}

async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error)
    server.once("error", fail)
    server.listen(port, host, () => { server.off("error", fail); resolve() })
  })
}

export async function beginLogin(options: { ports?: number[]; fetch?: Fetch; timeoutMs?: number } = {}): Promise<Login> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(32).toString("hex")
  const servers: Server[] = []
  let redirectUri = ""
  let settled = false
  let finished = false
  const controller = new AbortController()
  let resolve!: (credential: Credential.OAuth) => void
  let reject!: (error: Error) => void
  const callback = new Promise<Credential.OAuth>((yes, no) => { resolve = yes; reject = no })
  void callback.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => { clearTimeout(timer); for (const server of servers) { server.close(); server.closeIdleConnections() } }
  const cancel = () => {
    if (!finished) { finished = true; settled = true; controller.abort(); reject(new Error("JetBrains login cancelled or timed out.")) }
    close()
  }
  const handler: RequestListener = async (req, res) => {
    let url: URL
    try { url = new URL(req.url ?? "/", "http://localhost") } catch { res.writeHead(400); res.end("Invalid callback."); return }
    const received = url.searchParams.get("state") ?? ""
    const receivedBytes = Buffer.from(received)
    const stateBytes = Buffer.from(state)
    const validState = receivedBytes.length === stateBytes.length && timingSafeEqual(receivedBytes, stateBytes)
    if (settled || req.method !== "GET" || url.pathname !== "/" || !validState
      || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1) {
      res.writeHead(400); res.end("Invalid OAuth callback."); return
    }
    const code = url.searchParams.get("code")
    if (!code || code.length > 8192 || url.searchParams.has("error")) {
      res.writeHead(400); res.end("Authorization failed."); cancel(); return
    }
    settled = true
    try {
      const credential = await exchangeToken(new URLSearchParams({
        grant_type: "authorization_code", code, code_verifier: verifier,
        client_id: "junie-cli", redirect_uri: redirectUri,
      }), options.fetch, undefined, controller.signal)
      controller.signal.throwIfAborted()
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
      res.end("Signed in. You can close this window and return to OpenCode.")
      finished = true
      resolve(credential)
    } catch {
      res.writeHead(502); res.end("Authorization failed. Return to OpenCode.")
      if (!finished) { finished = true; reject(new Error("JetBrains login token exchange failed.")) }
    } finally { close() }
  }
  const ports = options.ports ?? Array.from({ length: 20 }, (_, index) => 62345 + index)
  let selected: number | undefined
  for (const port of ports) {
    const server = createServer(handler)
    server.requestTimeout = 10_000
    server.headersTimeout = 5_000
    try {
      await listen(server, port, "127.0.0.1")
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === "string") throw new Error()
      selected = address.port
      break
    } catch { server.close() }
  }
  if (selected === undefined) throw new Error("No loopback OAuth callback port available (62345–62364).")
  const ipv6 = createServer(handler)
  try { await listen(ipv6, selected, "::1"); servers.push(ipv6) } catch { ipv6.close() }
  redirectUri = `http://localhost:${selected}`
  const url = new URL("https://junie.jetbrains.com/cli-auth")
  url.search = new URLSearchParams({ client_id: "junie-cli", scope: "offline_access openid jb-authn-service", state, code_challenge: challenge, redirect_uri: redirectUri }).toString()
  const timeoutMs = options.timeoutMs ?? 300_000
  timer = setTimeout(cancel, timeoutMs)
  timer.unref()
  return { url: url.toString(), callback, expiresAt: Date.now() + timeoutMs, cancel }
}
