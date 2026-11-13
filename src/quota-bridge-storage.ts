import { constants, type Stats } from "node:fs"
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const unavailable = () => new Error("Junie bridge state unavailable.")

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw unavailable()
    return join(await canonical(dirname(path)), basename(path))
  }
}

async function directory(path: string, create: boolean): Promise<void> {
  if (dirname(path) !== path) await directory(dirname(path), create)
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw unavailable() })
  const info = await lstat(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0) || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000)))) throw unavailable()
}

async function privateDirectory(path: string): Promise<void> {
  await directory(path, false)
  const info = await lstat(path)
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw unavailable()
}

async function recoverPublication(path: string, published: Stats): Promise<void> {
  await privateDirectory(path)
  let count = 0
  for await (const entry of await opendir(path)) {
    if (++count > 128) throw unavailable()
    if (!/^\.pending-[a-f0-9]{32}$/.test(entry.name)) continue
    const staging = join(path, entry.name)
    const info = await lstat(staging).catch(error => {
      if (error.code !== "ENOENT") throw unavailable()
      return undefined
    })
    if (!info || info.dev !== published.dev || info.ino !== published.ino) continue
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 2) throw unavailable()
    // Only a matching private staging inode explains an interrupted publication.
    await unlink(staging).catch(error => { if (error.code !== "ENOENT") throw unavailable() })
    return
  }
}

async function readPrivate(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    let info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 512) throw unavailable()
    if (info.nlink === 2) { await recoverPublication(dirname(path), info); info = await file.stat() }
    if (info.nlink !== 1 || info.size > 512) throw unavailable()
    const buffer = Buffer.alloc(513)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 512) throw unavailable()
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally { await file.close().catch(() => {}) }
}

export async function prepareQuotaBridgeState(options: { stateDirectory?: string; workspaceRoots: readonly string[] }): Promise<{ directory: string; token: string }> {
  const path = resolve(options.stateDirectory ?? join(homedir(), ".local", "state", "opencode-jetbrains-junie-oauth", "quota-bridge-v1"))
  const actual = await canonical(path)
  for (const root of options.workspaceRoots) {
    if (root.length > 4096 || inside(resolve(root), path) || inside(await canonical(resolve(root)), actual)) throw unavailable()
  }
  await directory(path, true)
  await privateDirectory(path)
  const keyPath = join(path, "bridge.key")
  const temporary = join(path, `.pending-${randomBytes(16).toString("hex")}`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(randomBytes(32).toString("hex"))
    await file.sync()
    await file.close()
    await link(temporary, keyPath).catch(error => { if (error.code !== "EEXIST") throw unavailable() })
  } finally {
    await file.close().catch(() => {})
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw unavailable() })
  }
  const token = await readPrivate(keyPath)
  if (!/^[a-f0-9]{64}$/.test(token)) throw unavailable()
  return { directory: path, token }
}
