# opencode-memory-tree

[**English**](README.md)

OpenCode 插件：将对话历史压缩为层次化的记忆树。持久化、可搜索、AI 可主动访问——每个会话拥有自己独立的记忆树，相当于给每个会话提供近似无限的上下文。

---

## 安装

```bash
npm install -g opencode-memory-tree
opencode-memory-tree install
```

然后设置 API key（用于压缩摘要的 LLM 调用）：

```bash
export OPENCODE_MEMORY_API_KEY=sk-xxx
```

重启 OpenCode，插件会自动加载。

### 手动安装（不用 npm）

将 `opencode-memory-tree` 目录复制到项目的 `.opencode/plugins/memory-tree/`——OpenCode 会自动发现该目录下的插件，插件将只对该项目生效。（也可以复制到 `~/.config/opencode/plugins/memory-tree/` 对所有项目全局生效。）无需修改任何配置文件。

---

## 工作原理

### 两层结构：Buffer State + Memory Tree

```
OpenCode transform hook
       ↓
╔══════════════════════════════════╗
║       Buffer State（内存）       ║
║  ┌──────────────────────────────╢
║  │ 实时消息队列，每次 transform  │║
║  │ hook 时与 OpenCode 同步      │║
║  └──────────────────────────────╢
║  原始消息数达到 maxRaw          │║
║  （默认 10）→ 触发压缩          │║
╚══════════════════════════════════╝
       ↓
╔══════════════════════════════════╗
║      Memory Tree（磁盘）         ║
║  ┌──────────────────────────────╢
║  │ 分层节点树，持久化存储        │║
║  │ └ Level 0: 叶节点，保留原文   │║
║  │ └ Level 1+: 父节点，合并摘要  │║
║  └──────────────────────────────╢
║  AI 可通过 search_memory_tree   ║
║  工具主动检索历史                ║
╚══════════════════════════════════╝
```

### 每会话独立隔离

每个 OpenCode 会话拥有自己独立的记忆树：

- **Buffer 和树都是按会话隔离的**——存储在 `data/sessions/<sessionID>/` 下，一个会话的消息永远不会泄漏到另一个会话的上下文中。
- **恢复会话**（重启后使用同一会话 ID）会自动恢复其 buffer 和记忆树。
- **开启新会话**从干净的 buffer 和空树开始——换会话意味着全新的上下文，每个会话的记忆独立增长，最终接近无限上下文。
- 无跨会话状态竞争：并发的会话写入各自的目录。

### Buffer State

Buffer State 是一个内存中的消息队列，包含 OpenCode 原始上下文中的全部内容：

- 用户消息
- 助手回复
- thinking / reasoning
- 工具调用及结果
- 系统注入的提示（Plan / Build 模式等）

每收到新消息，插件通过 `experimental.chat.messages.transform` hook 将增量消息同步到 buffer。达到阈值后触发压缩。

### 压缩方式：完整上下文 + 尾部追加

当压缩触发时，插件将**整个 buffer 的内容**发送给 LLM——不仅仅是待压缩的那一段。待压缩的原文保留在原位置，同时在尾部复制一份并附上压缩指令：

```
发送给 LLM 的消息结构：

┌─────────────────────────────────────────┐
│ system: {system prompt}                  │
│ user: [node1_001] 第0-209条: <摘要>      │  ← 父节点
│ user: [node1_002] 第210-419条: <摘要>    │
│ user: [node0_007] 第420-489条: <摘要>    │  ← 剩余的叶节点
│ user: [node0_008] 第490-559条: <摘要>    │     (node0_001~006 已被合并)
│ user: 原始消息 560                        │
│ user: 原始消息 561                        │  ← 待压缩段（保留在
│ ...                                      │     原有位置不动）
│ user: 原始消息 629                        │
│ user: 原始消息 630                        │
│ user: 原始消息 631                        │  ← 剩余原始消息
│ ...                                      │     （累积到 maxRaw，
│ user: 原始消息 669                        │      下次触发压缩）
│ user: [COMPRESS] 压缩以下对话...          │  ← 压缩指令
│ user: 原始消息 560                        │
│ user: 原始消息 561                        │  ← 待压缩段（复制
│ ...                                      │     一份到尾部）
│ user: 原始消息 629                        │
│ user: Summary:                            │  ← 引导输出
└─────────────────────────────────────────┘
```

通过保留完整上下文 + 尾部追加目标内容，LLM 在生成旧内容的摘要时，**能看到之后发生的对话**，早期被修正的结论在摘要中能体现最终的正确状态。

### 节点数据结构

每个节点保存为一个独立的 JSON 文件。叶节点和父节点的结构不同。

**叶节点（level 0）**——由原始消息压缩而成，保留完整原文：

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

- `summary`: LLM 生成的该段对话摘要
- `details`: 所有原始消息的 JSON 字符串（完整保留，不丢失）
- `round_start` / `round_end`: 该段在对话中的消息范围

**父节点（level 1+）**——由多个子节点合并而成：

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

- `summary`: LLM 将子节点摘要合并生成的总摘要
- `children`: 子节点 ID 列表（用于逐级钻取）
- `details`: null（父节点不保存原始消息）

### Buffer State 的生命周期

```
阶段①：累积原始消息（达到 maxRaw 触发）
┌──────────────────────────────────────────────┐
│ [msg1] [msg2] [msg3] ... [msg10]            │
│ 原始消息数: 10/10（maxRaw 默认值）           │
└──────────────────────────────────────────────┘

阶段②：压缩前 minBatch 条 → 叶节点
┌──────────────────────────────────────────────┐
│ [node0_001 第0-4条: <摘要>] [msg6] ...      │
│         ↑ 5 条消息浓缩为 1 条摘要            │
│                                               │
│  磁盘上：node0_001.json                       │
│  ┌─────────────────────────────────────┐      │
│  │ summary: "用户要求收集对话数据..."   │      │
│  │ details: [原始消息1, 原始消息2, ...] │      │
│  └─────────────────────────────────────┘      │
└──────────────────────────────────────────────┘

阶段③：继续累积，产生多个叶节点
┌──────────────────────────────────────────────┐
│ [node0_001] [node0_002] [node0_003] ... ×6   │
│ 叶节点数: 6/6 → 触发向上合并                  │
└──────────────────────────────────────────────┘

阶段④：前 3 个叶节点合并为父节点
┌──────────────────────────────────────────────┐
│ [node1_001 第0-209条: <摘要>] [node0_004]    │
│   ↑ 3 条子摘要合并为 1 条总摘要               │
│                                               │
│  磁盘上：node1_001.json                       │
│  ┌─────────────────────────────────────┐      │
│  │ summary: "用户与助手交替输出..."     │      │
│  │ children: [node0_001, node0_002,    │      │
│  │            node0_003]               │      │
│  │ details: null                       │      │
│  └─────────────────────────────────────┘      │
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
        msg0-4   msg5-9    msg10-14  msg15-19
        (details) (details)  (details)  (details)
```

- **Level 0（叶节点）**：由原始消息压缩而成，`details` 保留完整原文
- **Level 1+（父节点）**：由下层节点摘要合并而成，只存摘要
- **search_memory_tree**：AI 主动查询工具，展开叶节点可看原文，展开父节点可看子节点

---

## 配置

所有配置集中在同一个文件：插件目录下的 `config.json`（例如 `.opencode/plugins/memory-tree/config.json`）

```json
{
  "compressor": {
    "apiKey": "",
    "model": "deepseek-v4-flash",
    "baseUrl": "https://opencode.ai/zen/go/v1"
  },
  "subAgents": ["explore", "general"],
  "maxSync": 50,
  "maxRaw": 10,
  "minBatch": 5,
  "compactThreshold": 6,
  "compactBranch": 3,
  "debug": false
}
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `compressor.apiKey` | `""` | 通过环境变量 `OPENCODE_MEMORY_API_KEY` 设置 |
| `compressor.model` | `deepseek-v4-flash` | 压缩使用的模型 |
| `compressor.baseUrl` | — | 模型 API 地址 |
| `maxSync` | 50 | 首次加载时最多从历史同步的消息数 |
| `maxRaw` | 10 | 原始消息超过此数量触发压缩 |
| `minBatch` | 5 | 每次压缩的消息数 |
| `compactThreshold` | 6 | 同层节点数达到此值触发向上合并 |
| `compactBranch` | 3 | 每次合并的子节点数 |
| `debug` | false | 为 true 时在会话数据目录写入 `debug.log` |

### API Key 安全

API key 通过环境变量设置，不会出现在任何代码或配置文件中：

```bash
export OPENCODE_MEMORY_API_KEY=sk-xxx
```

Windows 上永久设置：

```powershell
setx OPENCODE_MEMORY_API_KEY "sk-xxx"
```



---



## 数据存储

```
<项目>/.opencode/plugins/memory-tree/
└── data/
    └── sessions/
        └── <sessionID>/          ← 每个会话一个目录
            ├── buffer-states.json  ← Buffer state 快照
            ├── index.json          ← 树索引
            ├── meta.json           ← 会话元数据（如系统提示词）
            ├── debug.log           ← 调试日志（仅 debug: true 时）
            └── nodes/              ← 节点文件
                ├── node0_001.json  ← 叶节点（含原始消息）
                ├── node1_001.json  ← 父节点
                └── ...
```

数据按会话隔离——每个会话拥有自己的目录，每个项目拥有自己的 `data/` 根目录。

---

## 已知限制

- 压缩需要调用 LLM，会产生 API 费用
- 每个会话的记忆树相互独立，新会话不会继承旧会话的上下文（`search_memory_tree` 只能查询当前会话）
- 首次在已有对话中启用时，最多同步最近 50 条消息（`maxSync`）
- 子 Agent（subAgent）的消息不进入 buffer

---

## License

MIT
