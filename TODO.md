# TODO

## 1. 压缩异步化
- **现状**: index.js:127 `await doCompress` 阻塞 transform hook，消息管道等待压缩完成后才返回
- **目标**: 压缩不阻塞用户消息管道，后台异步执行
- **待讨论**: 方案细节

## 2. 压缩重试
- **现状**: compress.js:258 `callProviderAPI` 失败直接 `return null`，不会重试
- **目标**: 网络抖动 / API 临时故障时自动重试（指数退避）
- **待讨论**: 重试次数、退避策略

## 3. 压缩统计
- **现状**: 压缩过程没有输出，用户不知道发生了什么
- **目标**: 输出压缩信息（压缩了哪些消息、省了多少 token、树的高度）
- **待讨论**: 输出格式、输出位置

## [待讨论] 4. root_node_id 只写不更新
- **现状**: database.js:135-137 `root_node_id` 在第一个节点创建时设置，之后永不更新
- **影响**: 如果旧的 session 被 archive 后新创建节点，`getRootNodes()` 返回已归档的旧节点
- **实际影响**: 当前代码中 `getRootNodes` 未被工具调用，暂不影响功能

## [待讨论] 5. details 缺字段
- **现状**: compress.js:83-89 只存了 `role` / `content` / `original_id`，没存 `tool_call_id` / `tool_calls` / `_parts`
- **影响**: AI 通过 `search_memory_tree` 展开叶节点时看不到工具调用结构
