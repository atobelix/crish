# 10 · MCP 桥与输出缓冲盘点（素材）

> 方向 10 · MCP stdio JSON-RPC / 大输出缓冲 · 静态走读

## 1. MCP 模块拓扑

```
mcp/mod.rs
  servers.rs     — 配置表
  bridge.rs      — 薄门面 re-export
    bridge_protocol.rs — 常量 / 适配 / 响应解析
    bridge_session.rs  — 子进程 + JSON-RPC + 读线程 + 崩溃监测
    bridge_registry.rs — McpClientBridge / McpToolAdapter
  shell.rs       — 内→外 MCP 外壳（list/call ≡ registry）
register_plugin_server → bridge.start → register_runtime 并入 ToolRegistry
```

## 2. 会话结构（bridge_session.rs）

- fields: child/stdin Mutex<Option<…>>、pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>、tools/tool_index RwLock、stderr_tail Mutex<Vec<String>> 上限 20。
- request：serialize JSON 一行 + `\n` → stdin 写锁 → timeout 等待 oneshot。
- spawn_reader：BufReader.lines() 逐行 → serde_json::from_str::<Value> → 按 id 投递；无 id 忽略；非 JSON 忍容。
- spawn_crash_monitor：50ms try_wait 轮询。
- Drop：try_lock child start_kill 兜底。

## 3. 协议适配开销（bridge_protocol.rs）

- adapt_call_result：text 拼接 + structuredContent/content/isError clone 进 output Map。
- response_result：error 分支构造；result `.cloned()`。
- McpToolAdapter.execute：session.call_tool → request(tools/call) → adapt_call_result。

## 4. 内→外 shell（shell.rs）

- list_tools：每次 list_definitions 全量克隆 + JSON 组装。
- call_tool：execute 后 tool_output_to_call_result：
  - text = output.to_string() 或 String clone
  - structuredContent = **output.clone()**
  - 同一输出双份进响应 Value。

## 5. 大输出 / 缓冲风险

| 面 | 行为 | 风险 |
| -- | ---- | ---- |
| MCP stdout | lines() 整行 String | 无 max_line_bytes → 单行可 OOM |
| MCP stderr | 行入 Vec，>20 删头 | 有界；remove(0) O(n) 小 |
| shell 全量 bytes | OutputAccumulator.bytes 只增 | 完成前无上限；截断后才有 preview 语义 |
| shell preview | 头尾 24KB | 正面 |
| 工具 summarize | 依赖 budget Some | 默认 None 不触发 |
| MCP structuredContent | 整对象 clone | 大结果双拷贝 |

## 6. 注册与列表

- register_plugin_server：start 成功后 has → skip / get_adapter → register_runtime。
- 工具名 mcp_<sanitized>__<tool>。
- tools 快照 run 内锁定；MCP 后置注册若发生在快照后，run 内模型面看不到新工具（文档语义：注册表 run 内不可变假设）。

## 7. 超时矩阵

- initialize 10s / list 30s / call 30s（可 with_call_timeout 覆盖）。
- 会话层 request 超时移除 pending id，防泄漏。
- 写失败路径同样 remove pending。

## 8. 与 03/02 交叉

- 03 C1：ToolEnd.output 未 Arc 化，IPC 侧深拷贝——本方向补充执行侧已有多次 clone。
- 02 T2：工具卡片渲染——本方向事件批收口导致卡片“突然全出现”，与前端虚拟化无直接冲突但感知延迟差。
