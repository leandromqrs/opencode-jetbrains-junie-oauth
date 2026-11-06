import { Model, Provider } from "@opencode/plugin/effect"
import type { Catalog, Vendor } from "./catalog.js"
import { advertisedModels } from "./static-catalog.js"
import { UPSTREAM } from "./transport.js"

export const GOOGLE_BASE = `${UPSTREAM}/v1beta1/projects/jetbrains-grazie/locations/global/publishers/google`
export interface ModelBinding { id: string; wireID: string; vendor: Vendor }
export interface AccountModel extends ModelBinding {
  name: string
  context: number
  output: number | null
  efforts: readonly string[]
  defaultEffort: string
}
const withoutDate = (id: string) => id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "")

export function reconcileCatalog(catalog: Catalog): AccountModel[] {
  return advertisedModels.flatMap(model => {
    const listed = catalog.routes.find(route => route.vendor === model.vendor && route.status === 200 && !route.error)?.models ?? []
    const exact = listed.find(item => item.id === model.id)
    const aliases = listed.filter(item => withoutDate(item.id) === withoutDate(model.id))
    const remote = exact ?? (aliases.length === 1 ? aliases[0] : undefined)
    if (!remote) return []
    return [{ ...model, wireID: remote.id, context: remote.context ?? model.context, output: remote.output ?? model.output }]
  })
}

export function effortSettings(vendor: Vendor, effort: string): Record<string, unknown> {
  if (vendor === "anthropic") return { effort, thinking: { type: "adaptive" } }
  if (vendor === "google") return { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } }
  return { reasoningEffort: effort }
}

export function nativeModel(model: AccountModel): Model.Info {
  const providerID = Provider.ID.make("jetbrains")
  const packages: Record<Vendor, string> = {
    anthropic: "@opencode/ai/providers/anthropic-compatible",
    openai: "@opencode/ai/providers/openai",
    grok: "@opencode/ai/providers/xai",
    google: "@opencode/ai/providers/google",
  }
  return {
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    modelID: Model.ID.make(model.wireID), name: model.name, package: packages[model.vendor],
    settings: {
      baseURL: model.vendor === "google" ? GOOGLE_BASE : `${UPSTREAM}/v1`,
      ...effortSettings(model.vendor, model.defaultEffort),
    },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: model.context, output: model.output ?? 0 }, cost: [],
    variants: model.efforts.map(effort => ({ id: Model.VariantID.make(effort), settings: effortSettings(model.vendor, effort) })),
  }
}
