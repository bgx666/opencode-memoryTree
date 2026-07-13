import { findFirstUncompressed } from "./buffer.js"
import * as fs from "fs"

export async function doCompress(state, compressorConfig) {
  if (state.compressorBusy) return
  state.compressorBusy = true

  try {
    const didCompress = await compressLeaf(state, compressorConfig)
    if (didCompress) {
      let level = 0
      while (await compactOneLevel(state, compressorConfig, level)) {
        level++
      }
    }
    state.tree.saveBufferState(state.buffer, state.sessionId)
    fs.appendFileSync(
      state.logFilePath,
      `[doCompress post-save] ${Date.now()} inst=${state.instanceId} buffer[0]=${state.buffer[0]?._node_id} len=${state.buffer.length}\n`,
    )
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

  fs.appendFileSync(
    state.logFilePath,
    `[compressLeaf post-splice] ${Date.now()} inst=${state.instanceId} nodeId=${nodeId} startIdx=${startIdx} buffer[0]=${state.buffer[0]?._node_id} len=${state.buffer.length}\n`,
  )

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

  const log = (msg) =>
    fs.appendFileSync(
      state.logFilePath,
      `[${msg}] ${Date.now()} inst=${state.instanceId} targetIds=${targetIds.join(",")} firstTargetIdx=${firstTargetIdx} buffer[0]=${state.buffer[0]?._node_id} buffer[1]=${state.buffer[1]?._node_id}\n`,
    )

  log("pre-splice")
  for (let k = toReplace.length - 1; k >= 0; k--) {
    state.buffer.splice(toReplace[k], 1)
  }
  state.buffer.splice(firstTargetIdx, 0, parentMsg)
  log("post-splice")

  state.tree.saveBufferState(state.buffer, state.sessionId)
  log("post-save")

  state.tree.setNodesInactive(state.sessionId, targetIds)
  for (const cid of targetIds) {
    state.tree.updateNode(state.sessionId, cid, { parent_id: parentId })
  }

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

  return true
}

async function callProviderAPI(messages, config) {
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
    })

    if (!resp.ok) {
      const text = await resp.text()
      return null
    }

    const json = await resp.json()
    return json.choices?.[0]?.message?.content ?? null
  } catch (err) {
    return null
  }
}
