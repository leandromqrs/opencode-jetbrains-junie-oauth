import { open, constants } from "node:fs/promises"
import { quotaAdapterConfig, startQuotaAdapter } from "../dist/quota-adapter.js"

async function main() {
  const args = process.argv.slice(2)
  const keyIndex = args.indexOf("--key-file")
  if (keyIndex < 0 || !args[keyIndex + 1]) throw new Error("Invalid configuration")
  const [path] = args.splice(keyIndex, 2).slice(1)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let token
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.size < 32 || stat.size > 514) throw new Error("Invalid key file")
    const buffer = Buffer.alloc(515)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    token = buffer.subarray(0, bytesRead).toString("utf8").trim()
    buffer.fill(0)
  } finally { await file.close() }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    const config = quotaAdapterConfig(args, { JUNIE_QUOTA_ADAPTER_KEY: token })
    const adapter = await startQuotaAdapter({ ...config, signal: controller.signal })
    try {
      await new Promise(resolve => {
        if (controller.signal.aborted) resolve()
        else controller.signal.addEventListener("abort", resolve, { once: true })
      })
    } finally { await adapter.close() }
  } finally {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
}

void main().catch(() => {
  process.stderr.write("Quota adapter failed; check the private key file, configuration and listener port.\n")
  process.exitCode = 1
})
