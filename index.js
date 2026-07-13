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
let serverCallCount = 0

export default {
  id: "memory-tree",
  async server(ctx, options) {
    serverCallCount++
    const dir = (ctx.directory) || (ctx.worktree) || ""
    const pluginDir = __dirname
    const storePath = path.join(dir, ".opencode", "plugins", "memory-tree", "data")
    const logFilePath = path.join(storePath, "debug.log")

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

    const tree = new MemoryTree(storePath)

    fs.appendFileSync(logFilePath, `[server called] #${serverCallCount} dir=${ctx.directory} worktree=${ctx.worktree} options=${JSON.stringify(options)}\n`)

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
      } else {
        tree.archiveSessionNodes(TREE_KEY)
      }

      const savedPrompt = tree.getMeta("system_prompt") || ""

      const logFilePath = path.join(storePath, "debug.log")
      const instanceId = serverCallCount
      fs.appendFileSync(logFilePath, `--- session start (instance #${instanceId}) ---\n`)

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
        logFilePath,
        instanceId,
      }

      return state
    }

    const hooks = {
      "experimental.chat.messages.transform": async (
        _input, output
      ) => {
        const messages = output.messages
        if (!messages) return

        const agent = messages[0]?.info?.agent
        if (agent && subAgents.includes(agent)) return

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
            if (messages[i].info?.id === lastKnownId) {
              matchIdx = i
              break
            }
          }
        }

        const newMessages = matchIdx !== -1
          ? messages.slice(matchIdx + 1)
          : messages.slice(Math.max(0, messages.length - maxSync))
        for (const msg of newMessages) {
          const bm = messageToBuffer(msg.info, msg.parts)
          if (bm) s.buffer.push(bm)
        }

        const rawCount = rawMessageCount(s.buffer)
        if (rawCount >= s.config.maxRaw && compressorConfig) {
          await doCompress(s, compressorConfig)
        }

        fs.appendFileSync(
          s.logFilePath,
          `[transform pre-save] ${Date.now()} inst=${s.instanceId} buffer[0]=${s.buffer[0]?._node_id} buffer[1]=${s.buffer[1]?._node_id} len=${s.buffer.length}\n`,
        )
        s.tree.saveBufferState(s.buffer, TREE_KEY)

        output.messages.length = 0
        output.messages.push(...s.buffer.map(bufferToMessage))
      },

      "experimental.chat.system.transform": async (
        _input, output
      ) => {
        const system = output.system
        if (!system) return
        const s = getState()
        s.systemPrompt = system.join("\n")
        s.tree.setMeta("system_prompt", s.systemPrompt)
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
