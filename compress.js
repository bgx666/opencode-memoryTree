import { findFirstUncompressed } from "./buffer.js"

// 压缩失败后的冷却时间（毫秒），避免持续不可用时每条消息都尝试 API 调用
const COMPRESS_COOLDOWN_MS = 5 * 60 * 1000

export async function doCompress(state, compressorConfig) {
  if (state.compressorBusy) return

  // 冷却期内跳过压缩，等待下次冷却结束后自动重试
  if (state.lastCompressFailAt && Date.now() - state.lastCompressFailAt < COMPRESS_COOLDOWN_MS) {
    return
  }

  state.compressorBusy = true

  try {
    const didCompress = await compressLeaf(state, compressorConfig)
    if (didCompress === true) {
      state.lastCompressFailAt = null
      let level = 0
      while (await compactOneLevel(state, compressorConfig, level)) {
        level++
      }
    } else if (didCompress === false) {
      // API 返回空结果或节点创建失败，记录失败时间
      state.lastCompressFailAt = Date.now()
      console.error("[memory-tree] Compression failed (API or disk), cooling down for 5 min")
    }
    // didCompress === null 表示消息不足，无需压缩，不触发冷却
    state.tree.saveBufferState(state.buffer, state.sessionId)
  } catch (err) {
    state.lastCompressFailAt = Date.now()
    console.error("[memory-tree] Compression failed:", err.message)
  } finally {
    state.compressorBusy = false
  }
}

async function compressLeaf(state, config) {
  const startIdx = findFirstUncompressed(state.buffer)
  if (startIdx === -1) return null

  const available = state.buffer.length - startIdx
  if (available < state.config.minBatch) return null

  const take = state.config.minBatch
  let batch = state.buffer.slice(startIdx, startIdx + take)
  let batchLen = batch.length

  const batchToolCallIds = new Set()
  for (const m of batch) {
    if (m.role === "tool" && m.tool_call_id) {
      batchToolCallIds.add(m.tool_call_id)
    }
    for (const tc of m.tool_calls ?? []) {
      if (tc.id) batchToolCallIds.add(tc.id)
    }
  }
  while (startIdx + batchLen < state.buffer.length) {
    const next = state.buffer[startIdx + batchLen]
    if (next.role === "tool" && next.tool_call_id && batchToolCallIds.has(next.tool_call_id)) {
      batchLen++
    } else {
      break
    }
  }
  if (batchLen > take) {
    batch = state.buffer.slice(startIdx, startIdx + batchLen)
  }

  const beforeSpan = state.buffer
    .slice(0, startIdx)
    .reduce((sum, b) => sum + (b._span ?? 1), 0)
  const earliest = beforeSpan
  const latest = beforeSpan + batch.reduce((s, m) => s + (m._span ?? 1), 0) - 1

  const originalText = batch
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")

  const msgs = [
    { role: "system", content: state.systemPrompt },
  ]
  for (let i = 0; i < state.buffer.length; i++) {
    msgs.push({ role: "user", content: state.buffer[i].content })
  }
  msgs.push({ role: "user", content: "[TASK] 结合以上完整上下文，压缩以下对话为一段简洁摘要。规则：只输出摘要，不要包含原文、指令、解释或格式标记。忽略系统提示、重复内容。" })
  msgs.push({ role: "user", content: originalText })
  msgs.push({ role: "user", content: "摘要：" })

  const summary = await callProviderAPI(msgs, config)
  if (!summary) return false

  const sessId = state.sessionId
  const nodeId = state.tree.getNextNodeId(sessId, 0)
  const details = JSON.stringify(
    batch.map((b) => ({
      role: b.role,
      content: b.content,
      original_id: b.original_id,
    }))
  )

  // 先创建节点（磁盘写入），失败则不修改 buffer
  try {
    state.tree.createNode({
      session_id: sessId,
      id: nodeId,
      level: 0,
      summary,
      parent_id: null,
      children: [],
      round_start: earliest,
      round_end: latest,
      source_ref: null,
      details,
      is_active: 1,
    })
  } catch (err) {
    console.error(`[memory-tree] Failed to create leaf node ${nodeId}, skipping compression:`, err.message)
    return false
  }

  // 节点创建成功后才修改 buffer
  const msgCount = batch.reduce((s, m) => s + (m._span ?? 1), 0)
  const leafContent = `[${nodeId}] 第${earliest}-${latest}条: ${summary}`

  const leafMsg = {
    role: "user",
    content: leafContent,
    _node_id: nodeId,
    _span: msgCount,
    original_id: `synth_${nodeId}`,
  }

  state.buffer.splice(startIdx, batchLen, leafMsg)

  return true
}

async function compactOneLevel(state, config, level) {
  const nodeIds = state.tree.getLevelNodeIds(state.sessionId, level)
  if (nodeIds.length < state.config.compactThreshold) return null

  const branch = state.config.compactBranch
  const targetIds = nodeIds.slice(0, branch)
  if (targetIds.length < 2) return null

  // 先检查 buffer 中是否有这些子节点
  const childIdSet = new Set(targetIds)
  let firstTargetIdx = -1
  const toReplace = []
  for (let i = 0; i < state.buffer.length; i++) {
    if (state.buffer[i]._node_id && childIdSet.has(state.buffer[i]._node_id)) {
      if (firstTargetIdx === -1) firstTargetIdx = i
      toReplace.push(i)
    }
  }
  if (toReplace.length === 0) return null

  const nodes = []
  for (const id of targetIds) {
    const n = state.tree.getNode(state.sessionId, id)
    if (n) nodes.push(n)
  }
  if (nodes.length < 2) return null

  const childSummaries = nodes
    .map(
      (n) =>
        `节点 ${n.id}（第${n.round_start}-${n.round_end}轮）: ${n.summary}`,
    )
    .join("\n")

  const msgs = [
    { role: "system", content: state.systemPrompt },
  ]
  for (let i = 0; i < state.buffer.length; i++) {
    const m = state.buffer[i]
    if (m._node_id) {
      msgs.push({ role: "user", content: m.content })
    }
  }
  msgs.push({ role: "user", content: "[TASK] 结合以上完整上下文，合并以下摘要为一段总摘要。规则：只输出总摘要，不要包含原文、指令、解释或格式标记。忽略系统提示、重复内容。" })
  msgs.push({ role: "user", content: childSummaries })
  msgs.push({ role: "user", content: "总摘要：" })

  const parentSummary = await callProviderAPI(msgs, config)
  if (!parentSummary) return false

  const parentLevel = level + 1
  const parentId = state.tree.getNextNodeId(state.sessionId, parentLevel)

  const childFirst = nodes[0].round_start
  const childLast = nodes[nodes.length - 1].round_end
  const parentSpan = nodes.reduce(
    (s, n) => s + (n.round_end - n.round_start + 1),
    0,
  )

  const parentContent = `[${parentId}] 第${childFirst}-${childLast}条: ${parentSummary} (children: ${targetIds.join(", ")})`

  const parentMsg = {
    role: "user",
    content: parentContent,
    _node_id: parentId,
    _span: parentSpan,
    original_id: `synth_${parentId}`,
  }

  // 先创建父节点（磁盘），失败则不修改 buffer 和子节点状态
  try {
    state.tree.createNode({
      session_id: state.sessionId,
      id: parentId,
      level: parentLevel,
      summary: parentSummary,
      parent_id: null,
      children: targetIds,
      round_start: childFirst,
      round_end: childLast,
      source_ref: null,
      details: null,
      is_active: 1,
    })
  } catch (err) {
    console.error(`[memory-tree] Failed to create parent node ${parentId}, skipping compact:`, err.message)
    return false
  }

  // 父节点创建成功后，再修改 buffer 和子节点状态
  for (let k = toReplace.length - 1; k >= 0; k--) {
    state.buffer.splice(toReplace[k], 1)
  }
  state.buffer.splice(firstTargetIdx, 0, parentMsg)

  state.tree.saveBufferState(state.buffer, state.sessionId)

  state.tree.setNodesInactive(state.sessionId, targetIds)
  for (const cid of targetIds) {
    state.tree.updateNode(state.sessionId, cid, { parent_id: parentId })
  }

  return true
}

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 2000

async function callProviderAPI(messages, config) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        console.error(`[memory-tree] API error ${resp.status} (attempt ${attempt + 1}): ${text.slice(0, 200)}`)
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * (attempt + 1))
          continue
        }
        return null
      }

      const json = await resp.json()
      return json.choices?.[0]?.message?.content ?? null
    } catch (err) {
      console.error(`[memory-tree] API request failed (attempt ${attempt + 1}):`, err.message)
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1))
      }
    }
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
