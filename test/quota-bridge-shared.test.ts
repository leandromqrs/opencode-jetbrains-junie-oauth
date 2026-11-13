import { test } from "node:test"
import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { once } from "node:events"
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { createServer as httpServer } from "node:http"
import { prepareQuotaBridgeState } from "../src/quota-bridge-storage.js"
import { startSharedQuotaBridge } from "../src/quota-bridge-shared.js"
import { startQuotaBridge, quotaBridgeProof } from "../src/quota-bridge.js"
import { parseQuotaBridge } from "../src/quota-bridge-plugin.js"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHmac } from "node:crypto"

async function unusedPort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function exchange(child: ChildProcess, message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("message", receive); reject(new Error("Synthetic Junie child timed out")) }, 8000)
    const receive = (reply: unknown) => { clearTimeout(timer); resolve(reply) }
    child.once("message", receive)
    child.send(message)
  })
}

function childProcess(home: string, environment: Record<string, string> = {}) {
  return fork(fileURLToPath(new URL("./quota-bridge-shared-child.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { HOME: home, PATH: "", ...environment }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
}

test("separate processes attach without quota reads, survive owner crash, and preserve account-bound key after reboot", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/junie-shared-process-")
  const children = [childProcess(home), childProcess(home), childProcess(home)]
  try {
    const port = await unusedPort(), directory = join(home, "state")
    const start = { action: "start", port, directory }
    const owner = await exchange(children[0]!, start)
    assert.equal(owner.running, true)
    assert.equal(owner.calls, 0)
    const follower = await exchange(children[1]!, start)
    assert.equal(follower.running, true)
    assert.equal(follower.calls, 0)
    assert.equal((await exchange(children[1]!, { action: "query" })).ok, true)
    children[0]!.kill("SIGKILL")
    await once(children[0]!, "exit")
    let recovered = false
    for (let attempt = 0; attempt < 25 && !recovered; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      recovered = (await exchange(children[1]!, { action: "query" })).ok
    }
    assert.equal(recovered, true)
    assert.equal((await exchange(children[1]!, { action: "stop" })).keyPresent, false)
    assert.equal((await exchange(children[2]!, start)).running, true)
    assert.equal((await exchange(children[2]!, { action: "query" })).ok, true)
    await exchange(children[2]!, { action: "stop" })
  } finally { for (const child of children) if (child.connected) child.kill(); await rm(home, { recursive: true, force: true }) }
})

test("concurrent processes publish one private key and different accounts cannot consume the owner's balance", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/junie-shared-concurrent-")
  const children = [childProcess(home), childProcess(home), childProcess(home)]
  try {
    const start = { action: "start", port: await unusedPort(), directory: join(home, "state") }
    const replies = await Promise.all(children.slice(0, 2).map(child => exchange(child, start)))
    assert.deepEqual(replies.map(reply => [reply.running, reply.calls]), [[true, 0], [true, 0]])
    const conflict = await exchange(children[2]!, { ...start, account: "credential:other" })
    assert.equal(conflict.running, false)
    assert.equal(conflict.keyPresent, false)
    assert.equal((await exchange(children[2]!, { action: "query" })).ok, false)
    assert.equal((await exchange(children[0]!, { action: "query" })).ok, true)
    for (const child of children) await exchange(child, { action: "stop" })
    await new Promise(resolve => setTimeout(resolve, 650))
    const reservation = createServer()
    reservation.listen(start.port, "127.0.0.1")
    await once(reservation, "listening")
    await new Promise<void>(resolve => reservation.close(() => resolve()))
  } finally { for (const child of children) if (child.connected) child.kill(); await rm(home, { recursive: true, force: true }) }
})

test("private state rejects workspace paths, aliases, permissions, corruption, symlinks and arbitrary hardlinks", async () => {
  const home = await mkdtemp("/tmp/opencode/junie-shared-state-")
  try {
    const directory = join(home, "state"), keyPath = join(directory, "bridge.key"), root = join(home, "workspace")
    await mkdir(root)
    const state = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [root] })
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
    assert.equal((await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [root] })).token === state.token, true)
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: join(root, "private"), workspaceRoots: [root] }))
    await symlink(home, join(home, "alias"))
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [join(home, "alias")] }))
    await chmod(keyPath, 0o644)
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
    await chmod(keyPath, 0o600)
    await link(keyPath, join(home, "arbitrary-link"))
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
    await unlink(join(home, "arbitrary-link"))
    await link(keyPath, join(directory, `.pending-${"a".repeat(32)}`))
    assert.equal((await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] })).token === state.token, true)
    assert.equal((await stat(keyPath)).nlink, 1)
    assert.equal((await readFile(keyPath, "utf8")) === state.token, true)
    await writeFile(keyPath, "invalid", { mode: 0o600 })
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
    await unlink(keyPath)
    await symlink(join(home, "target"), keyPath)
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
    await unlink(keyPath)
    await writeFile(keyPath, "a".repeat(513), { mode: 0o600 })
    await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] }))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("a follower that changes account revokes its key without reading the owner's balance", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/junie-shared-account-")
  const children = [childProcess(home), childProcess(home)]
  try {
    const start = { action: "start", port: await unusedPort(), directory: join(home, "state") }
    for (const child of children) assert.equal((await exchange(child, start)).running, true)
    await exchange(children[1]!, { action: "change-account", account: "credential:other" })
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.equal((await exchange(children[1]!, { action: "query" })).ok, false)
    assert.equal((await exchange(children[0]!, { action: "query" })).ok, true)
    for (const child of children) await exchange(child, { action: "stop" })
  } finally { for (const child of children) if (child.connected) child.kill(); await rm(home, { recursive: true, force: true }) }
})

test("a follower adopts and revokes an inherited matching managed bearer after an account switch without changing the owner or conflicting values", { timeout: 20_000 }, async () => {
  const home = await mkdtemp("/tmp/opencode/junie-shared-inherited-")
  const children: ChildProcess[] = []
  try {
    const port = await unusedPort(), directory = join(home, "state")
    const state = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] })
    const inherited = createHmac("sha256", state.token).update(`junie-quota-bearer-v1:${port}:credential:fixture`).digest("hex")
    children.push(childProcess(home), childProcess(home, { JUNIE_SYNTHETIC_CHILD_BRIDGE_KEY: inherited }), childProcess(home, { JUNIE_SYNTHETIC_CHILD_BRIDGE_KEY: "conflicting-synthetic-inherited-key" }))
    const start = { action: "start", port, directory }
    for (const child of children.slice(0, 2)) assert.equal((await exchange(child, start)).running, true)
    assert.equal((await exchange(children[1]!, { action: "query" })).ok, true)
    const conflicting = await exchange(children[2]!, start)
    assert.equal(conflicting.running, false)
    assert.equal(conflicting.diagnostic, "incompatible-config")
    assert.equal(conflicting.keyPresent, true)
    await exchange(children[1]!, { action: "change-account", account: "credential:other" })
    let status: any
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await exchange(children[1]!, { action: "status" })
      if (status.diagnostic === "ambiguous-account") break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(status.diagnostic, "ambiguous-account")
    assert.equal(status.running, false)
    assert.equal(status.keyPresent, false)
    assert.equal((await exchange(children[1]!, { action: "query" })).ok, false)
    assert.equal((await exchange(children[0]!, { action: "query" })).ok, true)
    assert.equal((await exchange(children[0]!, { action: "status" })).keyPresent, true)
    assert.equal((await stat(join(directory, "bridge.key"))).isFile(), true)
    assert.equal((await exchange(children[2]!, { action: "stop" })).keyPresent, true)
    for (const child of children.slice(0, 2)) await exchange(child, { action: "stop" })
  } finally { for (const child of children) if (child.connected) child.kill(); await rm(home, { recursive: true, force: true }) }
})

test("unknown listeners never receive the bearer and cannot forge an authenticated attachment", async () => {
  let requests = 0
  const server = httpServer((request, response) => {
    requests++
    assert.equal(request.headers.authorization, undefined)
    response.writeHead(204, { "X-Junie-Protocol": "1", "X-Junie-Proof": "0".repeat(64) }); response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    await assert.rejects(startSharedQuotaBridge({ port: address.port, token: "synthetic-private-key-".repeat(3), getBalance: async () => { throw Error("must not run") } }))
    assert.equal(requests, 2)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test("health challenge is provider, port and direction bound and does not retrieve a balance", async () => {
  const token = "synthetic-private-key-".repeat(3), nonce = "1".repeat(64)
  const bridge = await startQuotaBridge({ port: 0, token, sharedHealth: true, getBalance: async () => { throw Error("must not run") } })
  const url = bridge.url.replace("/quota", "/quota-bridge-health")
  const challenge = `${new URL(url).port}:${nonce}`
  const headers = { "X-Junie-Nonce": nonce, "X-Junie-Proof": quotaBridgeProof(token, "request", challenge) }
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://invalid.example" } })).status, 403)
    assert.equal((await fetch(url, { headers: { ...headers, "X-Junie-Proof": quotaBridgeProof(token, "response", challenge) } })).status, 401)
    const response = await fetch(url, { headers })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get("x-junie-proof"), quotaBridgeProof(token, "response", challenge))
    assert.throws(() => parseQuotaBridge({ port: 62365, shared: true }))
    assert.throws(() => parseQuotaBridge({ port: 62365, autoKey: "true" }))
  } finally { await bridge.close() }
})
