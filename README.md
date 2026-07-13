# opencode-memory-tree

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
║        Buffer State (内存)       ║
║  ┌──────────────────────────────╢
║  │ 实时消息队列，每次 transform  │║
║  │ hook 时与 OpenCode 同步      │║
║  └──────────────────────────────╢
║  满 110 条原始消息 → 触发压缩    ║
╚══════════════════════════════════╝
       ↓
╔══════════════════════════════════╗
║       Memory Tree (磁盘)         ║
║  ┌──────────────────────────────╢
║  │ 分层节点树，持久化存储        │║
║  │ └ Level 0: 叶节点，保留原文   │║
║  │ └ Level 1+: 父节点，合并摘要  │║
║  └──────────────────────────────╢
║  AI 可通过 search_memory_tree   ║
║  工具主动检索历史                ║
╚══════════════════════════════════╝
```

### Buffer State

Buffer state 是一个内存中的消息队列，它包含 OpenCode 原始上下文的全部内容：

- 用户消息
- 助手回复
- thinking / reasoning
- 工具调用及结果
- 系统注入的提示（Plan / Build 模式等）

每收到新消息，插件通过 OpenCode 的 `experimental.chat.messages.transform` hook 将增量消息同步到 buffer 中。达到阈值后，触发压缩。

### Buffer State 快照变化

```
阶段①：累积原始消息（达到 110 条触发）
┌──────────────────────────────────────────────┐
│ [msg1] [msg2] [msg3] ... [msg110]            │
│ 原始消息数: 110/110                           │
└──────────────────────────────────────────────┘

阶段②：压缩前 70 条 → 叶节点
┌──────────────────────────────────────────────┐
│ [node0_001 第0-69条] [msg71] ... [msg110]    │
│         ↑ 70 条消息浓缩为 1 条摘要            │
└──────────────────────────────────────────────┘
  节点保存到磁盘：node0_001.json
  details 字段保留 70 条消息的完整原文

阶段③：继续累积，产生多个叶节点
┌──────────────────────────────────────────────┐
│ [node0_001] [node0_002] [node0_003] ... ×6   │
│ 叶节点数: 6/6 → 触发向上合并                  │
└──────────────────────────────────────────────┘

阶段④：前 3 个叶节点合并为父节点
┌──────────────────────────────────────────────┐
│ [node1_001] [node0_004] ...                   │
│   ↑ 3 条摘要合并为 1 条总摘要                 │
└──────────────────────────────────────────────┘
```

### Memory Tree 结构

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

- **Level 0（叶节点）**：由原始消息压缩而成，`details` 保留完整原文
- **Level 1+（父节点）**：由下层节点摘要合并而成，只存摘要
- **search_memory_tree**：AI 主动查询工具，展开节点可查看原文或子节点

---

## Configuration

所有配置集中在一个文件：`~/.config/opencode/plugins/memory-tree/config.json`

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

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `compressor.apiKey` | `""` | 通过环境变量 `OPENCODE_MEMORY_API_KEY` 设置 |
| `compressor.model` | `deepseek-v4-flash` | 压缩使用的模型 |
| `compressor.baseUrl` | — | 模型 API 地址 |
| `maxSync` | 50 | 首次同步时最多从历史拉取的消息数 |
| `maxRaw` | 110 | 原始消息超过此数量触发压缩 |
| `minBatch` | 70 | 一次压缩的消息数 |
| `compactThreshold` | 6 | 同层节点数达到此值触发向上合并 |
| `compactBranch` | 3 | 一次合并的子节点数 |

### API Key 安全

API key 通过环境变量传入，不会出现在任何代码或配置文件中：

```bash
export OPENCODE_MEMORY_API_KEY=sk-xxx
```

也可在 Windows 上永久设置：

```powershell
setx OPENCODE_MEMORY_API_KEY "sk-xxx"
```

---

## Usage

### AI 自动使用

安装后插件自动工作。当 buffer 中的原始消息超过 `maxRaw` 时，压缩过程自动触发。AI 也可以通过 `search_memory_tree` 工具主动查询历史记忆。

AI 在以下情况会自动使用该工具：

- 看到对话中出现的 `[nodeX_XXX]` 压缩摘要标记
- 对某段历史记忆不确定，需要回顾细节

### search_memory_tree

| 参数 | 说明 |
|------|------|
| `node_id` | 节点 ID，如 `node0_001`、`node1_002` |

- 叶节点（node0_XXX）：返回原始消息内容
- 父节点（node1_XXX 等）：返回子节点列表及摘要

---

## Comparison with OpenCode's built-in compaction

| | OpenCode 自带 compaction | memory-tree 插件 |
|---|---|---|
| **存储方式** | 不保留，压缩后原始消息丢失 | 节点持久化到磁盘，原文不丢 |
| **可查询** | 否 | 可，通过 `search_memory_tree` |
| **粒度** | 单层摘要 | 多层树结构，可钻取 |
| **AI 可控** | 被动触发 | 主动查询，AI 可自主决定 |

---

## Data Storage

```
.opencode/plugins/memory-tree/
└── data/
    ├── buffer-states.json    ← Buffer state 快照
    ├── index.json            ← 树索引
    ├── nodes/                ← 节点文件
    │   ├── node0_001.json    ← 叶节点（含原始消息）
    │   ├── node1_001.json    ← 父节点
    │   └── ...
    └── debug.log             ← 调试日志
```

每个项目的数据独立存储，互不干扰。

---

## Known limitations

- 压缩需要调用 LLM，会产生 API 费用
- 首次在已有对话中启用时，最多拉取最近 50 条消息（`maxSync`）
- 子 Agent（subAgent）的消息不进入 buffer

---

## License

MIT
