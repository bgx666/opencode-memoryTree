import { MemoryTree } from "./database.js"
import {
  bufferToMessage,
  rawMessageCount,
  messageToBuffer,
} from "./buffer.js"
import { doCompress } from "./compress.js"
import { createSearchMemoryTreeTool } from "./tool.js"
import path from "path"
import { fileURLToPath } from "url"
import * as fs from "fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TREE_KEY = "default"

export default {
  id: "memory-tree",
  async server(ctx, options) {
    const dir = (ctx.directory) || (ctx.worktree) || ""
    const pluginDir = __dirname
    const storePath = path.join(dir, ".opencode", "plugins", "memory-tree", "data")

    // 从 config.json 加载配置，options 中的值可以覆盖
    let config = {}
    try {
      config = JSON.parse(fs.readFileSync(path.join(pluginDir, "config.json"), "utf-8"))
    } catch {}
    const compressorApiKey = process.env.OPENCODE_MEMORY_API_KEY || config.compressor?.apiKey || null
    const compressorConfig = compressorApiKey && config.compressor?.model && config.compressor?.baseUrl
      ? { apiKey: compressorApiKey, model: config.compressor.model, baseUrl: config.compressor.baseUrl }
      : null
    const subAgents = options?.subAgents || config.subAgents || []
    const maxSync = options?.maxSync ?? config.maxSync ?? 50
    const debug = options?.debug ?? config.debug ?? false

    const tree = new MemoryTree(storePath)

    let state = null

    function getState() {
      if (state) return state

      const loaded = tree.loadBufferState(TREE_KEY)

      let buffer = []

      if (loaded) {
        try {
          buffer = JSON.parse(loaded.recent_buffer)
        } catch {
          buffer = []
        }
      }
      // 无存档时不再 archive 节点，保持跨会话接续

      const savedPrompt = tree.getMeta("system_prompt") || ""

      state = {
        sessionId: TREE_KEY,
        tree,
        buffer,
        compressorBusy: false,
        config: {
          maxRaw: config.maxRaw ?? 110,
          minBatch: config.minBatch ?? 70,
          compactThreshold: config.compactThreshold ?? 6,
          compactBranch: config.compactBranch ?? 3,
        },
        systemPrompt: savedPrompt,
        debug,
      }

      return state
    }

    function debugLog(s, msg) {
      if (!s.debug) return
      const logFilePath = path.join(storePath, "debug.log")
      fs.appendFile(logFilePath, `[${Date.now()}] ${msg}\n`, () => {})
    }

    const hooks = {
      "experimental.chat.messages.transform": async (
        _input, output
      ) => {
        try {
          const messages = output.messages
          if (!messages || !Array.isArray(messages)) return

          // 检查是否为 sub-agent 消息：遍历前几条消息检查 agent 字段
          const isSubAgent = messages.slice(0, 3).some(
            (m) => m?.info?.agent && subAgents.includes(m.info.agent)
          )
          if (isSubAgent) return

          const s = getState()

          let lastKnownId = null
          for (let i = s.buffer.length - 1; i >= 0; i--) {
            if (s.buffer[i].original_id) {
              lastKnownId = s.buffer[i].original_id
              break
            }
          }

          let matchIdx = -1
          if (lastKnownId) {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i]?.info?.id === lastKnownId) {
                matchIdx = i
                break
              }
            }
          }

          const newMessages = matchIdx !== -1
            ? messages.slice(matchIdx + 1)
            : messages.slice(Math.max(0, messages.length - maxSync))
          for (const msg of newMessages) {
            if (!msg?.info || !msg?.parts) continue
            const bm = messageToBuffer(msg.info, msg.parts)
            if (bm) s.buffer.push(bm)
          }

          const rawCount = rawMessageCount(s.buffer)
          if (rawCount >= s.config.maxRaw && compressorConfig) {
            await doCompress(s, compressorConfig)
          }

          debugLog(s, `[transform] buffer len=${s.buffer.length} rawCount=${rawCount}`)
          s.tree.saveBufferState(s.buffer, TREE_KEY)

          output.messages.length = 0
          output.messages.push(...s.buffer.map(bufferToMessage))
        } catch (err) {
          console.error("[memory-tree] messages.transform error:", err.message)
          // 插件出错时不干扰 OpenCode 正常流程
        }
      },

      "experimental.chat.system.transform": async (
        _input, output
      ) => {
        try {
          const system = output.system
          if (!system) return
          const s = getState()
          s.systemPrompt = system.join("\n")
          s.tree.setMeta("system_prompt", s.systemPrompt)
        } catch (err) {
          console.error("[memory-tree] system.transform error:", err.message)
        }
      },
    }

    return {
      tool: {
        search_memory_tree: createSearchMemoryTreeTool(tree, () => TREE_KEY),
      },
      ...hooks,
    }
  },
}
