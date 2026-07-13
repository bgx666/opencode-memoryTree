import { tool } from "@opencode-ai/plugin"

export function createSearchMemoryTreeTool(tree, getDefaultSessionId) {
  return tool({
    description:
      "Query compressed conversation segments by node ID to recall details from earlier in the conversation. " +
      "Use this tool proactively whenever you are unsure about something or need more context — " +
      "the memory tree stores the full original messages from compressed parts of the conversation. " +
      "For leaf nodes (node0_XXX), returns the original messages. " +
      "For parent nodes (node1_XXX, node2_XXX, etc.), returns summaries of child nodes.",
    args: {
      node_id: tool.schema
        .string()
        .describe("The node ID to query, e.g. node0_001, node1_002"),
    },
    async execute(args, context) {
      const sessionId = context.sessionID ?? getDefaultSessionId()
      const node = tree.getNode(sessionId, args.node_id)

      if (!node) {
        return `Node "${args.node_id}" not found in memory tree. ` +
          `Available nodes are marked with [nodeX_XXX] in the conversation.`
      }

      if (node.level === 0) {
        if (node.details) {
          try {
            const details = JSON.parse(node.details)

            if (Array.isArray(details)) {
              const messages = details.map((d, i) => {
                const role = d.role.toUpperCase()
                const content = d.content || "(empty)"
                return `[${role}] Message ${i + 1}:\n${content}`
              })
              return [
                `## Expanded Node: ${node.id}`,
                `Level: leaf (original messages)`,
                `Range: messages ${node.round_start ?? "?"} - ${node.round_end ?? "?"}`,
                `Summary: ${node.summary}`,
                `---`,
                `## Original Messages`,
                ``,
                messages.join("\n\n---\n\n"),
              ].join("\n")
            }
          } catch {
            return `## Node: ${node.id}\nSummary: ${node.summary}\n(Details could not be parsed)`
          }
        }
        return `## Node: ${node.id} (leaf)\nSummary: ${node.summary}\n(No detailed messages available)`
      }

      const children = tree.getChildren(sessionId, node.id)
      if (children.length === 0) {
        return `## Node: ${node.id} (level ${node.level})\nSummary: ${node.summary}\n(No child nodes found)`
      }

      const childList = children.map((child) => {
        const span =
          child.round_start && child.round_end
            ? ` (msgs ${child.round_start}-${child.round_end})`
            : ""
        return `- **[${child.id}]** (level ${child.level})${span}: ${child.summary}`
      })

      return [
        `## Node: ${node.id} (level ${node.level})`,
        `Summary: ${node.summary}`,
        ``,
        `## Child Nodes`,
        ``,
        childList.join("\n"),
        ``,
        `Use \`search_memory_tree\` with any child node ID to drill deeper.`,
      ].join("\n")
    },
  })
}
