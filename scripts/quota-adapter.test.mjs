import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "junie-adapter-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ["scripts", "dist", "bin"]) await mkdir(join(root, dir))
  for (const name of ["quota-adapter.sh", "quota-adapter-run.mjs", "service-with-quota.sh"]) await copyFile(new URL(name, import.meta.url), join(root, "scripts", name))
  await writeFile(join(root, "package.json"), '{"type":"module"}')
  await writeFile(join(root, "dist/quota-adapter.js"), `
export function quotaAdapterConfig(args, env) {
  if (env.JUNIE_QUOTA_ADAPTER_KEY !== "test-only-private-key-0123456789abcdef") throw Error("bad key");
  if (args[1] !== "/explicit/project") throw Error("bad location");
  return {};
}
export async function startQuotaAdapter({signal}) {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 5);
  return {close: async () => { if (!signal.aborted) throw Error("not aborted"); }};
}`)
  const record = join(root, "calls")
  await writeFile(join(root, "bin/systemctl"), `#!/usr/bin/env bash
case "$*" in
  *--property=LoadState*) printf '%s\\n' "\${TEST_LOAD:-not-found}" ;;
  *--property=Description*) printf '%s\\n' "\${TEST_DESCRIPTION:-OpenCode Junie standalone quota adapter v1}" ;;
  *--property=Transient*) printf '%s\\n' "\${TEST_TRANSIENT:-yes}" ;;
  *) printf '%s\\n' "$@" > "$TEST_RECORD" ;;
esac
`)
  await writeFile(join(root, "bin/systemd-run"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$TEST_RECORD"\nexit "${TEST_RUN_EXIT:-0}"\n')
  for (const name of ["systemctl", "systemd-run"]) await chmod(join(root, "bin", name), 0o700)
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_RECORD: record }
  const run = (args, overrides = {}, wrapper = "quota-adapter.sh") => spawnSync("bash", [join(root, "scripts", wrapper), ...args], { env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000 })
  return { root, record, run }
}

test("detached start uses one fixed transient unit, absolute runtime and no key value in argv", async t => {
  const { root, record, run } = await fixture(t)
  const result = run(["start", "--location", "/explicit/project"])
  assert.equal(result.status, 0, result.stderr)
  const args = await readFile(record, "utf8")
  assert.match(args, /--unit=opencode-junie-quota-adapter.service/)
  assert.match(args, /--service-type=exec/)
  assert.match(args, /--property=KillMode=control-group/)
  assert.match(args, /--collect/)
  assert.ok(args.includes(`${root}/scripts/quota-adapter-run.mjs`))
  assert.ok(!args.includes("test-only-private-key"))
  assert.ok(!args.includes("opencode service"))
})

test("duplicate and racing starts fail without stopping or replacing the existing unit", async t => {
  const { record, run } = await fixture(t)
  assert.equal(run(["start", "--location", "/explicit/project"], { TEST_LOAD: "loaded" }).status, 1)
  await assert.rejects(readFile(record))
  assert.equal(run(["start", "--location", "/explicit/project"], { TEST_RUN_EXIT: "1" }).status, 1)
  assert.ok(!(await readFile(record, "utf8")).includes("--replace"))
})

test("stop refuses unrelated or persistent units and is idempotent when absent", async t => {
  const { record, run } = await fixture(t)
  assert.equal(run(["stop"], { TEST_LOAD: "loaded", TEST_DESCRIPTION: "unrelated" }).status, 1)
  assert.equal(run(["stop"], { TEST_LOAD: "loaded", TEST_TRANSIENT: "no" }).status, 1)
  await assert.rejects(readFile(record))
  assert.equal(run(["stop"]).status, 0)
  assert.equal(run(["stop"], { TEST_LOAD: "loaded" }).status, 0)
  assert.match(await readFile(record, "utf8"), /stop\nopencode-junie-quota-adapter.service/)
})

test("explicit location is mandatory and old wrapper cannot restart the shared service", async t => {
  const { run } = await fixture(t)
  assert.equal(run(["start"]).status, 1)
  assert.equal(run(["start", "--location", "."]).status, 1)
  assert.equal(run(["start", "--location", "/explicit/project", "--port", "0"]).status, 1)
  assert.equal(run(["restart"], {}, "service-with-quota.sh").status, 2)
  assert.equal(run(["status"]).status, 0)
})

test("runtime reads only an owner-private regular key file and handles termination", async t => {
  const { root, run } = await fixture(t)
  const path = join(root, "adapter.key")
  await writeFile(path, "test-only-private-key-0123456789abcdef\n", { mode: 0o600 })
  const args = ["run", "--location", "/explicit/project", "--key-file", path]
  const valid = run(args)
  assert.equal(valid.status, 0, valid.stderr)
  await chmod(path, 0o644)
  const unsafe = run(args)
  assert.equal(unsafe.status, 1)
  assert.ok(!unsafe.stderr.includes("test-only-private-key"))
  await chmod(path, 0o600)
  const link = join(root, "key-link")
  await symlink(path, link)
  assert.equal(run(["run", "--location", "/explicit/project", "--key-file", link]).status, 1)
  assert.equal(run(["run", "--location", "/explicit/project", "--key-file", join(root, "missing")]).status, 1)
})
