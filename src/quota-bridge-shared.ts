import { randomBytes } from "node:crypto"
import { request } from "node:http"
import { quotaBridgeProof, validQuotaBridgeProof, startQuotaBridge, type QuotaBridge, type QuotaBridgeOptions } from "./quota-bridge.js"

function authenticate(options: QuotaBridgeOptions, signal: AbortSignal): Promise<boolean> {
  const nonce = randomBytes(32).toString("hex")
  return new Promise(resolve => {
    const req = request({ hostname: "127.0.0.1", port: options.port, path: "/quota-bridge-health", method: "GET", signal, maxHeaderSize: 4096, headers: {
      "X-Junie-Nonce": nonce, "X-Junie-Proof": quotaBridgeProof(options.token, "request", `${options.port}:${nonce}`),
    } }, response => {
      const proof = response.headers["x-junie-proof"]
      const ok = response.statusCode === 204 && response.headers["x-junie-protocol"] === "1" && typeof proof === "string" && validQuotaBridgeProof(options.token, "response", `${options.port}:${nonce}`, proof)
      response.destroy()
      resolve(ok)
    })
    const timer = setTimeout(() => req.destroy(), 1000)
    req.once("close", () => { clearTimeout(timer); resolve(false) })
    req.on("error", () => resolve(false))
    req.end()
  })
}

export async function startSharedQuotaBridge(options: QuotaBridgeOptions & { onAvailability?: (available: boolean) => void; checkAccount?: (signal: AbortSignal) => Promise<boolean> }): Promise<QuotaBridge> {
  const controller = new AbortController()
  let owned: QuotaBridge | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = 500
  let pending: Promise<boolean> | undefined
  const connect = async (): Promise<boolean> => {
    if (controller.signal.aborted) return false
    if (options.checkAccount && !await options.checkAccount(AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]))) return false
    if (controller.signal.aborted) return false
    if (await authenticate(options, controller.signal)) return true
    if (controller.signal.aborted) return false
    try { owned = await startQuotaBridge({ ...options, sharedHealth: true, signal: controller.signal }); return true }
    catch { return !controller.signal.aborted && await authenticate(options, controller.signal) }
  }
  const monitor = () => {
    timer = setTimeout(() => {
      pending = connect().catch(() => false)
      void pending.then(available => {
        delay = available ? 500 : Math.min(delay * 2, 4000)
        if (!controller.signal.aborted) { options.onAvailability?.(available); monitor() }
      })
    }, delay)
    timer.unref()
  }
  if (!await connect()) { controller.abort(); throw new Error("Shared Junie bridge unavailable.") }
  monitor()
  return {
    url: `http://127.0.0.1:${options.port}/quota`,
    async close() {
      controller.abort()
      clearTimeout(timer)
      await pending
      await owned?.close()
    },
  }
}
