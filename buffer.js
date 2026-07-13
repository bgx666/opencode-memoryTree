export function messageToBuffer(message, parts) {
  const info = message
  if (!info || typeof info !== "object") return null

  const role = (info.role) || "user"

  const content = extractText(parts)

  return {
    role: role,
    content,
    original_id: info.id,
    _span: 1,
    _parts: parts,
    tool_call_id: info.toolCallId,
    tool_calls: (info.toolCalls)?.map((tc) => ({
      id: tc.id,
      tool: tc.tool,
      state: tc.state,
    })),
  }
}

export function bufferToMessage(bm) {
  const info = {
    role: bm._node_id ? "user" : (bm.role || "user"),
    id: bm.original_id ?? `synth_${bm._node_id ?? bm.content.slice(0, 20)}`,
  }

  if (bm.tool_call_id) info.toolCallId = bm.tool_call_id
  if (bm.tool_calls) info.toolCalls = bm.tool_calls

  return {
    info,
    parts: bm._parts ?? [
      {
        type: "text",
        text: bm.content,
      },
    ],
  }
}

export function rawMessageCount(buffer) {
  return buffer.reduce((sum, b) => sum + (b._node_id ? 0 : (b._span ?? 1)), 0)
}

export function extractText(parts) {
  return parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
}

export function findFirstUncompressed(buffer) {
  for (let i = 0; i < buffer.length; i++) {
    if (!buffer[i]._node_id) return i
  }
  return -1
}
