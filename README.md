# opencode-memory-tree

> **⚠️ BETA** — This plugin is in active development. APIs and data format may change.

[**中文**](README.zh-CN.md)

OpenCode plugin: compress conversation history into a hierarchical memory tree. Persistent, searchable, AI-accessible — across sessions, within the same project.

---

## Installation

```bash
npm install -g opencode-memory-tree
opencode-memory-tree install
```

Then set your API key (used for compression summarization):

```bash
export OPENCODE_MEMORY_API_KEY=sk-xxx
```

Restart OpenCode. The plugin will be loaded automatically.

### Manual installation (no npm)

Copy the `opencode-memory-tree` directory to `~/.config/opencode/plugins/memory-tree/` — OpenCode auto-discovers plugins in that directory. No config file change needed.

---

## How it works

### Two layers: Buffer State + Memory Tree

```
OpenCode transform hook
       ↓
╔══════════════════════════════════╗
║        Buffer State (memory)     ║
║  ┌──────────────────────────────╢
║  │ Real-time message queue,     │║
║  │ synced with OpenCode on      │║
║  │ every transform hook call    │║
║  └──────────────────────────────╢
║  110 raw messages → compression │║
╚══════════════════════════════════╝
       ↓
╔══════════════════════════════════╗
║       Memory Tree (disk)         ║
║  ┌──────────────────────────────╢
║  │ Hierarchical node tree,      │║
║  │ persisted to disk            │║
║  │ └ Level 0: leaf, has details │║
║  │ └ Level 1+: parent, merged   │║
║  └──────────────────────────────╢
║  AI can query via               ║
║  search_memory_tree tool        ║
╚══════════════════════════════════╝
```

### Buffer State

The buffer state is an in-memory message queue. It contains everything from OpenCode's original context:

- User messages
- Assistant responses
- Thinking / reasoning
- Tool calls and results
- System-injected prompts (Plan / Build mode, etc.)

On each new message, the plugin syncs incremental messages via the `experimental.chat.messages.transform` hook. When the raw message count reaches the threshold, compression is triggered.

### Compression approach: full context + append target

When compression triggers, the plugin sends the **complete buffer** to the LLM — not just the segment being compressed. The target text is duplicated and appended at the end with compression instructions:

```
What the LLM receives:

┌─────────────────────────────────────────┐
│ system: {system prompt}                  │
│ user: [node1_001] msgs 0-209: <summary>  │  ← parent nodes
│ user: [node1_002] msgs 210-419: <summary>│
│ user: [node0_007] msgs 420-489: <summary>│  ← remaining leaf nodes
│ user: [node0_008] msgs 490-559: <summary>│     (node0_001~006 merged)
│ user: raw message 560                    │
│ user: raw message 561                    │  ← target segment
│ ...                                      │    (still in original
│ user: raw message 629                    │     position)
│ user: raw message 630                    │
│ user: raw message 631                    │  ← remaining raw messages
│ ...                                      │    (total 110, triggering
│ user: raw message 669                    │     next compression)
│ user: [COMPRESS] Compress the following  │  ← instruction
│ user: raw message 560                    │
│ user: raw message 561                    │  ← target segment
│ ...                                      │    (copied to tail)
│ user: raw message 629                    │
│ user: Summary:                           │  ← output prompt
└─────────────────────────────────────────┘
```

By preserving the full context and appending the target at the end, the LLM can see **future messages** while generating the summary for older content. This means earlier conclusions that were later corrected are summarized in their final, correct form.

### Node data structure

Each node is saved as a separate JSON file. The structure differs between leaf and parent nodes.

**Leaf node (level 0)** — compressed from raw messages, retains full original text:

```json
{
  "id": "node0_001",
  "level": 0,
  "summary": "用户要求收集对话数据，指令为当用户说\"1\"时助手也回复\"1\"。助手执行了该指令...",
  "round_start": 0,
  "round_end": 69,
  "details": "[{\"role\":\"user\",\"content\":\"我们现在需要收集一些对话数据，我说1，你也说1。\"},{\"role\":\"assistant\",\"content\":\"1\"},...]",
  "is_active": 1
}
```

- `summary`: LLM-generated summary of this segment
- `details`: JSON string of all original messages (preserved in full)
- `round_start` / `round_end`: message range within the session

**Parent node (level 1+)** — merged from multiple child nodes:

```json
{
  "id": "node1_001",
  "level": 1,
  "summary": "用户与助手在对话数据收集中通过交替输出\"1\"完成了6轮交互...",
  "children": ["node0_001", "node0_002", "node0_003"],
  "round_start": 0,
  "round_end": 209,
  "details": null,
  "is_active": 1
}
```

- `summary`: LLM-generated summary merging child node summaries
- `children`: list of child node IDs (for drill-down)
- `details`: null (parent nodes do not store original messages)

### Buffer State lifecycle

```
Phase ①: Accumulate raw messages (110 reached → trigger)
┌──────────────────────────────────────────────┐
│ [msg1] [msg2] [msg3] ... [msg110]            │
│ raw messages: 110/110                         │
└──────────────────────────────────────────────┘

Phase ②: Compress first 70 messages → leaf node
┌──────────────────────────────────────────────┐
│ [node0_001 第0-69条: <summary>] [msg71] ...  │
│       ↑ 70 messages condensed into 1 summary │
│                                               │
│  Disk: node0_001.json                         │
│  ┌─────────────────────────────────────┐      │
│  │ summary: "用户要求收集对话数据..."   │      │
│  │ details: [原始消息1, 原始消息2, ...] │      │
│  └─────────────────────────────────────┘      │
└──────────────────────────────────────────────┘

Phase ③: Continue accumulating, more leaf nodes
┌──────────────────────────────────────────────┐
│ [node0_001] [node0_002] [node0_003] ... ×6   │
│ leaf count: 6/6 → merging triggered           │
└──────────────────────────────────────────────┘

Phase ④: Merge 3 leaf nodes into parent
┌──────────────────────────────────────────────┐
│ [node1_001 第0-209条: <summary>] [node0_004] │
│   ↑ 3 child summaries merged into 1 parent    │
│                                               │
│  Disk: node1_001.json                         │
│  ┌─────────────────────────────────────┐      │
│  │ summary: "用户与助手交替输出..."     │      │
│  │ children: [node0_001, node0_002,    │      │
│  │            node0_003]               │      │
│  │ details: null                       │      │
│  └─────────────────────────────────────┘      │
└──────────────────────────────────────────────┘
```

### Memory Tree structure

```
Level 2               node2_001
                    ↗          ↘
Level 1       node1_001       node1_002
             ↗    ↘          ↗    ↘
Level 0  node0_001 node0_002 node0_003 node0_004
          ↓         ↓         ↓         ↓
       msg1-70  msg71-140  msg141-210 msg211-280
        (details) (details)  (details)  (details)
```

- **Level 0 (leaf)**: Compressed from raw messages, `details` field preserves original text
- **Level 1+ (parent)**: Merged from child node summaries, only stores summary
- **search_memory_tree**: AI query tool — expands leaf nodes to original messages, expands parent nodes to show children

---

## Configuration

All settings in one file: `~/.config/opencode/plugins/memory-tree/config.json`

```json
{
  "compressor": {
    "apiKey": "",
    "model": "deepseek-v4-flash",
    "baseUrl": "https://opencode.ai/zen/go/v1"
  },
  "subAgents": ["explore", "general"],
  "maxSync": 50,
  "maxRaw": 110,
  "minBatch": 70,
  "compactThreshold": 6,
  "compactBranch": 3
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `compressor.apiKey` | `""` | Set via `OPENCODE_MEMORY_API_KEY` env var |
| `compressor.model` | `deepseek-v4-flash` | Model used for compression |
| `compressor.baseUrl` | — | API endpoint |
| `maxSync` | 50 | Max messages synced from history on first load |
| `maxRaw` | 110 | Raw message count triggering compression |
| `minBatch` | 70 | Messages compressed per batch |
| `compactThreshold` | 6 | Node count at a level triggering parent merge |
| `compactBranch` | 3 | Nodes merged per parent |

### API Key Security

The API key is set via environment variable, never committed to code or config:

```bash
export OPENCODE_MEMORY_API_KEY=sk-xxx
```

Permanent setup on Windows:

```powershell
setx OPENCODE_MEMORY_API_KEY "sk-xxx"
```

---

## AI Usage

The plugin works automatically. When raw messages exceed `maxRaw`, compression runs in the background. The AI can also query historical conversations using the `search_memory_tree` tool:

- **Leaf node** (`node0_XXX`): Returns original messages
- **Parent node** (`node1_XXX`, etc.): Returns child list and summaries

The AI is encouraged to use this tool proactively whenever it needs more context from earlier in the conversation.



---

## Data Storage

```
.opencode/plugins/memory-tree/
└── data/
    ├── buffer-states.json    ← Buffer state snapshot
    ├── index.json            ← Tree index
    ├── nodes/                ← Node files
    │   ├── node0_001.json    ← Leaf node (has details)
    │   ├── node1_001.json    ← Parent node
    │   └── ...
    └── debug.log             ← Debug log
```

Data is isolated per project — each project has its own `data/` directory.

---

## Known limitations

- Compression requires LLM API calls (costs apply)
- On first load, syncs at most 50 recent messages (`maxSync`)
- Sub-agent messages do not enter the buffer

---

## License

MIT
