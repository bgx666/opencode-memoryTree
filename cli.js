#!/usr/bin/env node

import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const GLOBAL_CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".config", "opencode")
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "opencode.json")

function log(msg) {
  console.log(`[opencode-memory-tree] ${msg}`)
}

function error(msg) {
  console.error(`[opencode-memory-tree] ERROR: ${msg}`)
}

async function install() {
  log("Installing opencode-memory-tree...")

  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }

  let config = { plugin: [] }
  if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8"))
    } catch {
      config = { plugin: [] }
    }
  }

  const pluginSpec = "opencode-memory-tree"

  // 检查是否已安装
  const existing = config.plugin?.find((p) => {
    const spec = Array.isArray(p) ? p[0] : p
    return spec === pluginSpec || spec.endsWith("/opencode-memory-tree")
  })
  if (existing) {
    log("Already installed.")
    return
  }

  // 添加插件注册
  if (!config.plugin) config.plugin = []
  config.plugin.push(pluginSpec)

  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8")
  log(`Registered in ${GLOBAL_CONFIG_FILE}`)
  log("Done! Restart OpenCode to activate.")
  log("")
  log("Next steps:")
  log("  1. Set your API key:")
  log("     export OPENCODE_MEMORY_API_KEY=sk-xxx")
  log("     (or set it permanently in your shell profile)")
  log("  2. Optionally edit config.json for compression settings")
}

const command = process.argv[2]
if (command === "install") {
  install()
} else if (command === "help" || !command) {
  console.log(`
Usage: opencode-memory-tree <command>

Commands:
  install   Register the plugin in global OpenCode config
  help      Show this help
`)
} else {
  error(`Unknown command: ${command}`)
  process.exit(1)
}
