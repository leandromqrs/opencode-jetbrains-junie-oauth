import { Rpc } from "@opencode/plugin/rpc"
import { formatJunieBalance, type JunieBalance } from "./quota.js"

export const quotaPanelRPC = Rpc.define({
  id: "jetbrains.quota",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object", required: ["label", "groups"], additionalProperties: false,
        properties: {
          label: { type: "string", minLength: 1, maxLength: 48 },
          groups: {
            type: "array", maxItems: 1,
            items: {
              type: "object", required: ["title", "value"], additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 48 },
                value: { type: "string", minLength: 1, maxLength: 48 },
              },
            },
          },
        },
      },
    },
  },
  events: {},
})

export function quotaPanelSnapshot(label: string, balance: JunieBalance) {
  return {
    label,
    groups: balance.state === "available"
      ? [{ title: "Balance", value: formatJunieBalance(balance) }]
      : [],
  }
}
