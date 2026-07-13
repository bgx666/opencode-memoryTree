# opencode-memory-tree

[**中文**](README.zh-CN.md)

OpenCode plugin: compress conversation history into a hierarchical memory tree. Persistent, searchable, AI-accessible — across sessions, across projects.

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

### Buffer State lifecycle

```
Phase ①: Accumulate raw messages (110 reached → trigger)
┌──────────────────────────────────────────────┐
│ [msg1] [msg2] [msg3] ... [msg110]            │
│ raw messages: 110/110                         │
└──────────────────────────────────────────────┘

Phase ②: Compress first 70 messages → leaf node
┌──────────────────────────────────────────────┐
│ [node0_001 msgs0-69] [msg71] ... [msg110]    │
│       ↑ 70 messages condensed into 1 summary │
└──────────────────────────────────────────────┘
  Saved to disk: node0_001.json
  details field preserves all 70 original messages

Phase ③: Continue accumulating, more leaf nodes
┌──────────────────────────────────────────────┐
│ [node0_001] [node0_002] [node0_003] ... ×6   │
│ leaf count: 6/6 → merging triggered           │
└──────────────────────────────────────────────┘

Phase ④: Merge 3 leaf nodes into parent
┌──────────────────────────────────────────────┐
│ [node1_001] [node0_004] ...                   │
│   ↑ 3 summaries merged into 1 parent summary  │
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

## Comparison with OpenCode's built-in compaction

| | OpenCode compaction | memory-tree plugin |
|---|---|---|
| **Storage** | Not preserved after compaction | Persisted to disk, original text kept |
| **Searchable** | No | Yes, via `search_memory_tree` |
| **Granularity** | Single-level summary | Multi-level tree, drillable |
| **AI control** | Passive (triggered at limit) | Active (AI queries on demand) |

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
