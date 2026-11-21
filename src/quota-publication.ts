import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { toJunieQuotaV1, type JunieBalance } from "./quota.js"

const quotaReceiver = Rpc.define({
  id: "slkiser.opencode-quota",
  methods: {
    publishQuota: {
      input: { type: "object", properties: { providerId: { type: "string" }, ticket: { type: "string" }, snapshot: { type: "object" } }, required: ["providerId"], additionalProperties: false },
      output: { type: "object", properties: { accepted: { type: "boolean" }, ticket: { type: "string" } }, required: ["accepted"] },
    },
  },
  events: {},
})

export function publishJunieQuota(ctx: Plugin.Context, balance: Effect.Effect<JunieBalance, unknown>) {
  const receiver = ctx.rpc(quotaReceiver)
  const providerId = "jetbrains"
  const publish = Effect.gen(function* () {
    const receiverStatus = yield* receiver.publishQuota({ providerId })
    if (typeof receiverStatus !== "object" || receiverStatus === null || !("accepted" in receiverStatus) || receiverStatus.accepted !== true) return
    if (!("ticket" in receiverStatus) || typeof receiverStatus.ticket !== "string") return
    const { ticket } = receiverStatus
    const result = yield* balance
    const snapshot = result.state === "available" ? toJunieQuotaV1(result) : { version: "quota-v1", entries: [] }
    yield* receiver.publishQuota({ providerId, ticket, snapshot })
  }).pipe(Effect.catch(() => Effect.void))
  return Effect.sleep("15 seconds").pipe(
    Effect.andThen(publish.pipe(Effect.andThen(Effect.sleep("30 seconds")), Effect.forever)),
  )
}
