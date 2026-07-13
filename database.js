import * as fs from "fs"
import * as path from "path"

export class MemoryTree {
  constructor(storeDir) {
    this.storePath = storeDir
    this.nodesDir = path.join(storeDir, "nodes")
    this.indexFile = path.join(storeDir, "index.json")
    this.bufferFile = path.join(storeDir, "buffer-states.json")
    this.metaFile = path.join(storeDir, "meta.json")

    this.index = {
      root_node_id: null,
      nodes_by_level: {},
    }
    this.bufferStates = new Map()
    this.meta = {}
    this.levelCounters = new Map()

    fs.mkdirSync(this.nodesDir, { recursive: true })

    this.loadIndex()
    this.loadBufferStates()
    this.loadMeta()
    this.initLevelCounters()
  }

  loadIndex() {
    if (fs.existsSync(this.indexFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf-8"))
        this.index = {
          root_node_id: raw.root_node_id ?? null,
          nodes_by_level: raw.nodes_by_level ?? {},
        }
      } catch {}
    }
  }

  saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), "utf-8")
  }

  loadBufferStates() {
    if (fs.existsSync(this.bufferFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.bufferFile, "utf-8"))
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string") {
            this.bufferStates.set(k, JSON.parse(v))
          } else {
            this.bufferStates.set(k, v)
          }
        }
      } catch {}
    }
  }

  saveBufferStates() {
    const bm = {}
    for (const [k, v] of this.bufferStates) {
      bm[k] = v
    }
    fs.writeFileSync(this.bufferFile, JSON.stringify(bm, null, 2), "utf-8")
  }

  loadMeta() {
    if (fs.existsSync(this.metaFile)) {
      try { this.meta = JSON.parse(fs.readFileSync(this.metaFile, "utf-8")) } catch {}
    }
  }

  saveMeta() {
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2), "utf-8")
  }

  initLevelCounters() {
    if (!fs.existsSync(this.nodesDir)) return
    for (const f of fs.readdirSync(this.nodesDir)) {
      if (!f.endsWith(".json")) continue
      const stem = f.replace(".json", "")
      const parts = stem.split("_")
      if (parts.length !== 2) continue
      const level = parseInt(parts[0].replace("node", ""), 10)
      const num = parseInt(parts[1], 10)
      if (isNaN(level) || isNaN(num)) continue
      const cur = this.levelCounters.get(level) ?? 0
      if (num > cur) this.levelCounters.set(level, num)
    }
  }

  close() {
    this.saveIndex()
    this.saveBufferStates()
    this.saveMeta()
  }

  saveBufferState(buffer, sessionId) {
    this.bufferStates.set(sessionId, {
      recent_buffer: JSON.stringify(buffer, null, 2),
    })
    this.saveBufferStates()
  }

  loadBufferState(sessionId) {
    return this.bufferStates.get(sessionId) ?? null
  }

  nodeFilePath(nodeId) {
    return path.join(this.nodesDir, `${nodeId}.json`)
  }

  createNode(node) {
    const entry = {
      session_id: node.session_id,
      id: node.id,
      level: node.level,
      summary: node.summary,
      parent_id: node.parent_id ?? null,
      children: node.children ?? [],
      round_start: node.round_start ?? 0,
      round_end: node.round_end ?? 0,
      source_ref: node.source_ref ?? null,
      details: node.details ?? null,
      is_active: node.is_active ?? 1,
    }
    fs.writeFileSync(this.nodeFilePath(node.id), JSON.stringify(entry, null, 2), "utf-8")

    const levelKey = String(entry.level)
    const list = this.index.nodes_by_level[levelKey] ?? []
    if (!list.includes(node.id)) {
      list.push(node.id)
      this.index.nodes_by_level[levelKey] = list
    }
    if (!this.index.root_node_id) {
      this.index.root_node_id = node.id
    }
    this.saveIndex()
  }

  getNode(_sessionId, nodeId) {
    const fp = this.nodeFilePath(nodeId)
    if (!fs.existsSync(fp)) return null
    try {
      return JSON.parse(fs.readFileSync(fp, "utf-8"))
    } catch {
      return null
    }
  }

  getChildren(sessionId, parentId) {
    const parent = this.getNode(sessionId, parentId)
    if (!parent || !parent.children.length) return []
    const result = []
    for (const cid of parent.children) {
      const n = this.getNode(sessionId, cid)
      if (n) result.push(n)
    }
    return result.sort((a, b) => a.round_start - b.round_start)
  }

  getLevelNodeIds(_sessionId, level) {
    const levelKey = String(level)
    const ids = this.index.nodes_by_level[levelKey] ?? []
    const active = []
    for (const id of ids) {
      const n = this.getNode(_sessionId, id)
      if (n && n.is_active === 1) active.push(id)
    }
    return active
  }

  getRootNodes(sessionId) {
    if (!this.index.root_node_id) return []
    const root = this.getNode(sessionId, this.index.root_node_id)
    return root ? [root] : []
  }

  getAllActiveNodes(sessionId) {
    const result = []
    for (const levelKey of Object.keys(this.index.nodes_by_level)) {
      for (const id of this.index.nodes_by_level[levelKey]) {
        const n = this.getNode(sessionId, id)
        if (n && n.is_active === 1) {
          result.push(n)
        }
      }
    }
    return result.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level
      return a.round_start - b.round_start
    })
  }

  searchNodes(sessionId, query) {
    const all = this.getAllActiveNodes(sessionId)
    const lowerQuery = query.toLowerCase()
    return all.filter((n) => {
      if (n.summary && n.summary.toLowerCase().includes(lowerQuery)) return true
      if (n.details) {
        try {
          const details = JSON.parse(n.details)
          if (Array.isArray(details)) {
            for (const d of details) {
              if (d.content && d.content.toLowerCase().includes(lowerQuery)) return true
            }
          }
        } catch {}
      }
      return false
    })
  }

  updateNode(sessionId, nodeId, updates) {
    const n = this.getNode(sessionId, nodeId)
    if (!n) return
    if (updates.summary !== undefined) n.summary = updates.summary
    if (updates.parent_id !== undefined) n.parent_id = updates.parent_id
    if (updates.children !== undefined) n.children = updates.children
    if (updates.is_active !== undefined) n.is_active = updates.is_active
    fs.writeFileSync(this.nodeFilePath(nodeId), JSON.stringify(n, null, 2), "utf-8")
  }

  setNodesInactive(sessionId, nodeIds) {
    for (const id of nodeIds) {
      this.updateNode(sessionId, id, { is_active: 0 })
    }
  }

  archiveSessionNodes(sessionId) {
    for (const levelKey of Object.keys(this.index.nodes_by_level)) {
      for (const id of this.index.nodes_by_level[levelKey]) {
        const n = this.getNode(sessionId, id)
        if (n && n.is_active === 1) {
          this.updateNode(sessionId, id, { is_active: 0 })
        }
      }
    }
  }

  getNextNodeId(_sessionId, level) {
    const cur = this.levelCounters.get(level) ?? 0
    const next = cur + 1
    this.levelCounters.set(level, next)
    return `node${level}_${String(next).padStart(3, "0")}`
  }

  setMeta(key, value) {
    this.meta[key] = value
    this.saveMeta()
  }

  getMeta(key) {
    return this.meta[key] ?? null
  }

  deleteSession(sessionId) {
    for (const levelKey of Object.keys(this.index.nodes_by_level)) {
      for (const id of [...this.index.nodes_by_level[levelKey]]) {
        const fp = this.nodeFilePath(id)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      }
      delete this.index.nodes_by_level[levelKey]
    }
    this.index.root_node_id = null
    this.bufferStates.delete(sessionId)
    this.saveIndex()
    this.saveBufferStates()
  }
}
