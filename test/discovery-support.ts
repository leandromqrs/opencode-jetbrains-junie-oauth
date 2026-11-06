import { Effect, type Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"

export function memoryStorage() {
  const values = new Map<string, Schema.Json>()
  const storage: Plugin.Context["storage"] = {
    get: key => Effect.sync(() => structuredClone(values.get(key))),
    set: (key, value) => Effect.sync(() => { values.set(key, structuredClone(value)) }),
    remove: key => Effect.sync(() => { values.delete(key) }),
    scan: options => Effect.sync(() => ({ entries: [...values].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) })),
  }
  return { values, storage }
}
