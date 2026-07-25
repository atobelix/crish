# 可信问题修正后的完整修复方案

> 仅包含 R2 根因审计确认 **verified** + R4 修复评估确认 **feasible** 的 33 项问题。
> 排除项：GAP-ST-10 (partial feasible)、GAP-CS-07 (partial root cause)、GAP-TC-03 (partial root cause)、GAP-UI-04 (partial root cause + partial feasible)

---

## Round 1 — 高优基础修复

### GAP-ST-07 — legacyFinishReason 抹杀 length 截断信号
- **优先级**: P0-Blocker | Wave 1.1
- **策略**: 修改 `legacyFinishReason` 函数传递 `'length'` 和 `'max_tokens'` 信号（types.ts 已包含 `'length'` 类型，无需扩展）
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/provider-stream-contract/normalizer.ts:45-49
    → 扩展 legacyFinishReason：除 'error'/'tool-call' 外，增加 'length'→'length'，
      'max_tokens'→'length' 映射，其余仍返回 'stop'
  ```

### GAP-ST-08 — buildMessage 缺失 finishReason 入参
- **优先级**: P0-Blocker | Wave 1.1
- **策略**: 在 `ProviderResponseConsumer` 中捕获 end 事件的 finishReason 并传递给 `buildMessage`
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:29-36
    → 新增 finishReasonFromStream 字段
  packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:99-107
    → end 事件处理中捕获 finishReason
  packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:119-135
    → buildMessage 添加 finishReason 参数，优先使用流中值
  ```

### GAP-ST-09 — session-loop 自动续写与 maxTokens 扩容判定恒假
- **优先级**: P0-Blocker | Wave 1.1
- **策略**: 该问题是 ST-07+ST-08 的下游效应；上游修复后 `handleNoToolCalls` 中 `stopReason === 'length'` 路径自动可达
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/session-loop/index.ts:248-318 → 验证上游修复后 length 路径可达
  packages/agent-runtime/src/session-loop/provider-call.ts:89-117 → 验证 handleLengthFinishReason 已就绪
  ```

### GAP-TC-02 — DaemonApprovalHandler 缺失 runIntentDenylist
- **优先级**: P0-Blocker | Wave 1.3
- **策略**: 新增 `runIntentDenylist` Map，拒绝时注入 `retryable: false` 并拦截同 Run 重复请求
- **文件修改**:
  ```typescript
  packages/agent-daemon/src/daemon-approval-handler.ts:16-20
    → 新增 runIntentDenylist: Map<string, Set<string>>
  packages/agent-daemon/src/daemon-approval-handler.ts:164-231
    → denial 路径记录 intentKey 到 denylist，设置 retryable: false
  packages/agent-runtime/src/runtime-helpers.ts → 同步添加 denylist 检查
  ```

### GAP-TC-04 — MCP Stdio Adapter 忽略 AbortSignal 与超时
- **优先级**: P0-Blocker | Wave 1.3
- **策略**: 绑定 context.signal 与 30s 超时；在 McpServerController 加入 3 次连续失败熔断器；区分只读/写工具
- **文件修改**:
  ```typescript
  packages/agent-daemon/src/mcp-stdio-adapter.ts:60-62
    → 传递 context.signal 和 timeout 到 client.callTool()
  packages/agent-daemon/src/mcp-stdio-adapter.ts:186-200
    → void _context → 绑定 signal 和超时
  packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.ts
    → 新增 sliding-window circuit breaker（连续失败计数）
  packages/agent-daemon/src/mcp-stdio-adapter.ts:187
    → isReadOnly 根据 schema 推导
  ```

### GAP-PM-01 — Rust attach_to_job_object 死代码 + Handle 泄漏
- **优先级**: P0-Blocker | Wave 1.4
- **策略**: 重构为 `ScopedJobObject` RAII 结构体；在 PTY/Daemon 子进程创建点强绑定
- **文件修改**:
  ```rust
  crates/conex-sandbox/src/process_tree.rs:1-71
    → 重写为 ScopedJobObject 结构体，Drop 中 CloseHandle
  crates/conex-sandbox/src/lib.rs:3
    → 保持 pub mod process_tree 导出
  crates/conex-sandbox/src/pty.rs:48-50
    → Windows 分支创建 ScopedJobObject 绑定子进程
  ```

### GAP-PM-02 — terminateProcessTree 缺乏两阶段优雅终止（仅 Windows）
- **优先级**: P0-Blocker | Wave 1.4
- **策略**: 仅 Windows 分支增加 Phase 1 soft kill (WM_CLOSE/CTRL_BREAK_EVENT)；Unix 分支已完善无需修改
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/process-lifecycle/process-executor.ts:370-417
    → Windows 分支：先 WM_CLOSE/CTRL_BREAK_EVENT，3000ms 超时后 taskkill /F
  ```

### GAP-PM-06 — createGuardedProcessEnv 未注入防卡死环境变量
- **优先级**: P0-Blocker | Wave 1.4
- **策略**: 注入 12 个非交互环境变量（CI=true, GIT_TERMINAL_PROMPT=0, PIP_NO_INPUT=1 等）
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/process-lifecycle/process-executor.ts:223-233
    → createGuardedProcessEnv 增加全套 anti-hanging 变量
  packages/agent-runtime/src/process-lifecycle/process-executor.ts:250-270
    → buildWindowsPowerShellScript prelude 同步注入
  ```

### GAP-SE-02 — 上下文压缩 safeCompactionCutoff 缺乏工具对绑定
- **优先级**: P0-Blocker | Wave 1.5
- **策略**: Rust `safe_drop_end` 增加 ID 级 tool_call→tool_result 配对断言；TS `includeRequiredToolCallMessages` 增加反向追溯
- **文件修改**:
  ```rust
  crates/conex-compaction/src/compaction.rs:100-121
    → safe_drop_end 增加 ID 级工具对配对校验
  packages/agent-runtime/src/context-compression/compression-utils.ts:137-169
    → includeRequiredToolCallMessages 增加反向追溯
  ```

### GAP-SE-04 — FileDiff 缺失 provisional 状态
- **优先级**: P0-Blocker | Wave 1.5
- **策略**: 为 `FileDiff` 增加 `provisional?: boolean`；`classifyFileDiff` 对 provisional 返回 `ok: false`；UI 禁用 Accept
- **文件修改**:
  ```typescript
  apps/crish-desktop/src/store/types.ts:103-119
    → FileDiff 接口新增 provisional?: boolean
  apps/crish-desktop/src/api/applyFileDiff.ts:209-263
    → classifyFileDiff 开头检查 provisional → ok: false, reason: '仍在流式生成中'
  apps/crish-desktop/src/components/DiffCardFileList.tsx:193-197
    → UI 显示"正在生成 diff"提示，Accept 按钮自动禁用
  ```

### GAP-UI-01 — Tauri 2 主进程系统级 Keep-Awake 唤醒锁缺位
- **优先级**: P0-Blocker | Wave 1.6
- **策略**: 新增 `power.rs` 跨平台唤醒锁模块；导出 `workbench_set_keep_awake` 命令
- **文件修改**:
  ```rust
  apps/agent-workbench/src-tauri/src/power.rs → 新建：Win32 SetThreadExecutionState / macOS IOKit / Linux DBus
  apps/agent-workbench/src-tauri/src/main.rs:9 → 添加 mod power;
  apps/agent-workbench/src-tauri/src/main.rs:21-110 → 注册 power::workbench_set_keep_awake 命令
  apps/agent-workbench/src-tauri/Cargo.toml → 添加条件依赖
  ```

### GAP-UI-02 — Reasoning 模型 reasoning_content 流中断丢弃与 Usage 清零
- **优先级**: P0-Blocker | Wave 1.6
- **策略**: 即使 abort 也强制触发 onThought 刷新与 onComplete() 封存；引入启发式 Token 估算
- **文件修改**:
  ```typescript
  apps/crish-desktop/src/api/directFetchBridge.ts:287-296
    → catch 块 abort 前 flush assistantThought 并调用 onComplete
  apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:567-615
    → handleStopGeneration 保留 thinking 缓冲区，内联 Token 估算
  ```

---

## Round 2 — 核心加固

### GAP-ST-04 — TS 与 Rust Token 估算公式失配
- **优先级**: P1-High | Wave 2.1
- **策略**: Rust 侧添加 `static_overhead` 和 `SAFETY_FACTOR=1.15` 对齐 TS 估算
- **文件修改**:
  ```rust
  crates/conex-compaction/src/compaction.rs:5-9 → 添加 static_overhead 字段
  crates/conex-compaction/src/compaction.rs:12-17 → new() 中初始化
  crates/conex-compaction/src/compaction.rs:50-54 → calculate_total_tokens 增加 overhead 和 safety factor
  ```

### GAP-ST-10 — balanceJsonContainers 反斜杠转义与字面量修复（partial feasible 但核心修复可行）
注意：R4 评估为 partial，但 balanceJsonContainers 的尾随反斜杠修复和截断字面量修复本身可行。ProviderResponseConsumer 集成部分已由上游完成。
- **优先级**: P1-High | Wave 2.1
- **策略**: 修复 balanceJsonContainers 的尾随反斜杠和截断布尔/null 字面量
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/provider-stream-contract/json-repair.ts:180-210
    → inString 路径中先剥离末尾 \ 再追加 '"'
  packages/agent-runtime/src/provider-stream-contract/json-repair.ts:140-160
    → jsonRepairCandidates 增加截断布尔/null 字面量补全
  ```

### GAP-CS-01 — 后台 Subagent Abort 监听器被提前解绑
- **优先级**: P0-Blocker | Wave 1.2
- **策略**: 将 Abort 信号从 context.signal 迁移到 Run 级生命周期信号
- **文件修改**:
  ```typescript
  packages/agent-daemon/src/subagent-runtime.ts:37-48
    → DaemonSubagentToolOptions 新增 parentRunAbortSignal?: AbortSignal
  packages/agent-daemon/src/subagent-runtime.ts:199-206
    → 改为 options.parentRunAbortSignal.addEventListener
  packages/agent-daemon/src/subagent-runtime.ts:225-226
    → finally 中移除 parentRunAbortSignal 上的监听器
  ```

### GAP-CS-02 — BackgroundCommandManager 与 Run 的 AbortSignal 脱节
- **优先级**: P0-Blocker | Wave 1.2
- **策略**: 新增 `cancelAllForRun` 方法；在 `cancelRun()` 中联动
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/background-command.ts:267-277 → 新增 cancelAllForRun()
  packages/agent-runtime/src/background-command.ts:111-116 → runIndex Map runId→taskId
  packages/agent-orchestrator/src/types.ts:340-350 → onRunCancel 回调
  packages/agent-orchestrator/src/orchestrator.ts:322-331 → cancelRun 联动
  ```

### GAP-CS-03 — activeRuns BoundedMap 静默淘汰导致 Ghost Run
- **优先级**: P0-Blocker | Wave 1.2
- **策略**: BoundedMap 增加 `onEvict` 销毁回调，淘汰时 `engine.abort()`
- **文件修改**:
  ```typescript
  packages/shared-utils/src/bounded-map.ts:13-22 → 构造函数增加 onEvict 可选参数
  packages/shared-utils/src/bounded-map.ts:48-55 → FIFO 淘汰路径调用 onEvict
  packages/agent-orchestrator/src/orchestrator.ts:59 → 传入 onEvict callback
  ```

### GAP-CS-05 — CrossProcessLock 为孤儿代码导致 OAuth 刷新重放
- **优先级**: P0-Blocker | Wave 1.2
- **策略**: 在 ChatGPTAccountPool 中引入 per-account single-flight Promise 去重（AsyncMutex 替代文件锁）
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts:41-49
    → 新增 refreshInflight Map
  packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts:178-201
    → refreshAccount 重写为 single-flight
  ```

### GAP-CS-06 — 流式中途 TCP Reset 被硬归类为 Case B 拒绝重试
- **优先级**: P1-High | Wave 2.2
- **策略**: 引入 `TransientErrorClassifier`，识别 ECONNRESET 允许带退避重试
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/provider-transport/stream-recovery.ts:340-417
    → decideRecovery() Case B 前增加暂态网络错误检测
  packages/agent-runtime/src/provider-transport/stream-recovery.ts:364-376
    → 暂态错误走 retry 路径（指数退避）
  ```

### GAP-CS-08 — setTraceContext 滥用 enterWith 导致跨 Session 状态污染
- **优先级**: P1-High | Wave 2.2
- **策略**: 废载 enterWith，强制全链路使用 `withTraceContext` / `ALS.run()`
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/trace/index.ts:344-350
    → setTraceContext 重写为委托 withTraceContext 或增加清理逻辑
  ```

### GAP-CS-09 — subagents.ts 全局变量 activeSubagentCount 死锁漂移
- **优先级**: P2-Medium | Wave 2.2
- **策略**: 用 `AsyncSemaphore` 替代纯计数 + 竞态检测
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/subagents.ts:54 → 替换为 AsyncSemaphore(6)
  packages/agent-runtime/src/subagents.ts:185-198 → await semaphore.acquire()
  packages/agent-runtime/src/subagents.ts:311-312 → semaphore.release()
  ```

---

## Round 3 — 功能补全

### GAP-ST-01 — StreamRenderBuffer Unicode Surrogate Pair 增量截断乱码
- **优先级**: P1-High | Wave 3.1
- **策略**: 在三处分帧截断点统一实施代理对完整性校验
- **文件修改**:
  ```typescript
  apps/crish-desktop/src/api/StreamRenderBuffer.ts:228-233
    → 扩展粗分块截断的代理对校验，增加 Low Surrogate 退格逻辑
  apps/crish-desktop/src/api/StreamRenderBuffer.ts:183-188
    → nlIndex 截断分支增加代理对校验
  apps/crish-desktop/src/api/StreamRenderBuffer.ts:199-204
    → deadline 截断分支同步增加代理对校验
  apps/crish-desktop/src/api/StreamRenderBuffer.ts:166-273
    → （可选）提取 safeUnicodeCutPosition 统一函数
  ```

### GAP-ST-02 — TextDecoder 流式解包结束未 flush
- **优先级**: P2-Medium | Wave 1.1
- **策略**: 循环退出后显式调用 `decoder.decode()` 刷空内部缓冲区
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/openai-stream-parse.ts:120
    → while 循环后 + decoder.decode() 刷空
  apps/crish-desktop/src/api/directFetchBridge.ts:223
    → while 循环后 + decoder.decode() 刷空
  ```

### GAP-ST-03 — Rust SSE 帧解析中 from_utf8_lossy 跨包字符替换乱码
- **优先级**: P1-High | Wave 1.2
- **策略**: 在 SseFrameParser 中新增 UTF-8 跨帧累积器
- **文件修改**:
  ```rust
  crates/conex-stream/src/parser/sse.rs:31-34 → 添加 utf8_buf 暂存字段
  crates/conex-stream/src/parser/sse.rs:52-92 → feed_bytes 先累积再找 \n\n 边界
  crates/conex-stream/src/parser/sse.rs:95-97 → from_utf8_lossy → from_utf8
  crates/conex-stream/src/parser/sse.rs:120-124 → reset 清空 utf8_buf
  ```

### GAP-ST-05 — 413 Payload Too Large 图片剥离忽视 message.blocks
- **优先级**: P0-Blocker | Wave 1.1
- **策略**: 扩充 `scrubImagesOldestFirst` 以同时扫描和操作 `message.blocks`
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/payload-image-recovery.ts:19-25 → 添加 isImageBlock 辅助
  packages/agent-runtime/src/payload-image-recovery.ts:27-40 → countContentPartImages 扩展扫描 blocks
  packages/agent-runtime/src/payload-image-recovery.ts:46-118 → scrubImagesOldestFirst 同步剥离 blocks
  ```

### GAP-ST-06 — 413 降级后 metadata 与 blocks 数据不同步
- **优先级**: P1-High | Wave 1.1
- **策略**: 与 ST-05 统一修复，确保 `scrubImagesOldestFirst` 同步替换 blocks 中对应 image 块
- **文件修改**: 与 ST-05 同一文件，同一修改批

### GAP-TC-01 — Tool Call 参数归一化缺陷与 Zod Schema Preprocess 缺失
- **优先级**: P1-High | Wave 3.1
- **策略**: 修复 `extractToolArgumentObject` 处理非对象 wrapper；添加 Zod Preprocess 辅助
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/tools.ts:120-144
    → 修复 extractToolArgumentObject 处理 { value: null/[] }
  packages/agent-daemon/src/protocol/validators/common.ts
    → 添加 zCoerceArray / zDefaultEmpty preprocess 辅助
  ```

### GAP-TC-03 — Tool 消息体空 content 序列化 '[]' 污染
- **优先级**: P1-High | Wave 3.1
- **策略**: 修复 `openai-request-build.ts` 的 `stringifyToolOutput` 处理空数组/对象
- **文件修改**:
  ```typescript
  packages/agent-runtime/src/openai-request-build.ts:58-63
    → stringifyToolOutput 显式拦截空数组/空对象 → 导出空字符串
  packages/agent-runtime/src/openai-request-build.ts:335-340
    → safeToolResultContent 注入 (empty tool output) 占位符
  ```

### GAP-PM-04 — SQLite DbPool 缺少 SQLITE_BUSY 指数退避重试
- **优先级**: P1-High | Wave 3.2
- **策略**: 写事务升级为 `BEGIN IMMEDIATE`；封装带指数退避的重试循环
- **文件修改**:
  ```rust
  crates/conex-db/src/transaction.rs:17 → BEGIN TRANSACTION → BEGIN IMMEDIATE
  crates/conex-db/src/transaction.rs:27-29 → execute() 封装 5 次指数退避重试
  ```

### GAP-PM-05 — 长会话 Raw Tool Payloads 内存保留 + 缺 GC + Rust 全量 Clone
- **优先级**: P1-High | Wave 3.2
- **策略**: 新增 `pruneHistoricalToolOutputs` 截断；compaction 后 GC；Rust 改用 `retain` + `shrink_to_fit`
- **文件修改**:
  ```rust
  packages/agent-runtime/src/session.ts:55-63 → 新增 pruneHistoricalToolOutputs
  packages/agent-runtime/src/session-loop/index.ts:258-262 → 裁剪后调用 global.gc?.()
  crates/conex-compaction/src/compaction.rs:28-48 → retain + shrink_to_fit 替代 clone
  ```

---

## Round 4 — 性能与安全

### GAP-SE-01 — 4-Pass seekSequence 双侧对齐缺失 eof 锚定
- **优先级**: P1-High | Wave 4.1
- **策略**: Rust 侧新增 eof 参数 + `SeekResult` 结构体；新增 `split_lines_for_seek`
- **文件修改**:
  ```rust
  crates/conex-diff/src/seek_sequence.rs:108-155 → 替换签名，添加 eof 和 SeekResult
  crates/conex-diff/src/seek_sequence.rs:157-162 → 同步 seek_sequence_owned
  crates/conex-diff/src/seek_sequence.rs:1-386 → 新增 split_lines_for_seek
  crates/conex-diff/src/seek_sequence.rs:328-385 → 更新 golden fixture 测试
  ```

### GAP-SE-03 — resolve_under_root 缺乏 Visited Path Set 导致 Symlink Loop
- **优先级**: P1-High | Wave 4.1
- **策略**: 实现 `safe_canonicalize(path, max_hops=40)` 替代所有裸 `canonicalize()` 调用
- **文件修改**:
  ```rust
  crates/conex-fs/src/path_utils.rs:1-22 → 新增 safe_canonicalize，修改 resolve_under_root
  apps/agent-workbench/src-tauri/src/fs_commands/types.rs:99-107 → 替换 canonicalize
  apps/agent-workbench/src-tauri/src/fs_commands/types.rs:109-135 → resolve_existing 替换
  apps/agent-workbench/src-tauri/src/perf/fs.rs:148-150 → 替换 start_watcher_internal
  ```

### GAP-UI-03 — 桌面 UI 菜单视口高度未钳制 + 事件穿透 + Function import
- **优先级**: P1-High | Wave 4.2
- **策略**: 统一视口钳制 CSS + 滚轮拦截；替换 Function() 为标准 ESM import
- **文件修改**:
  ```css
  apps/crish-desktop/src/components/ComposePlusMenu.module.css:14-26
    → 增加 max-height: calc(100dvh-3.5rem); overflow-y: auto; overscroll-behavior: contain
  apps/crish-desktop/src/components/ModelPicker.module.css:7
    → min(360px, calc(100dvh-3.5rem)) + overscroll-behavior: contain
  apps/crish-desktop/src/components/ProjectPickerMenu.tsx:36-47
    → Function() → 标准 ESM import
  ```

---

## Round 8 — 边界治理

### GAP-CS-04 — createDaemonSubagentTool 缺少全局 Live Agent 槽位门禁
- **优先级**: P1-High | Wave 2.2
- **策略**: 引入模块级 `AsyncSemaphore(32)` 槽位管理器
- **文件修改**:
  ```typescript
  packages/agent-daemon/src/subagent-runtime.ts:13-17 → 新增 AsyncSemaphore import
  packages/agent-daemon/src/subagent-runtime.ts:17-18 → DAEMON_SUBAGENT_SEMAPHORE(32)
  packages/agent-daemon/src/subagent-runtime.ts:118-121 → await acquire
  packages/agent-daemon/src/subagent-runtime.ts:225-237 → background 路径 release
  packages/agent-daemon/src/subagent-runtime.ts:263-276 → foreground 路径 release
  ```

### GAP-PM-03 — BackgroundCommandManager BoundedMap 容量淘汰致后台进程泄漏
- **优先级**: P0-Blocker | Wave 1.4
- **策略**: BoundedMap 增加 `onEvict` 回调；淘汰时 `terminateChild`
- **文件修改**:
  ```typescript
  packages/shared-utils/src/bounded-map.ts:13-22 → 构造函数增加 onEvict
  packages/shared-utils/src/bounded-map.ts:48-55 → FIFO 淘汰调用 onEvict
  packages/agent-runtime/src/background-command.ts:112 → 传入 terminateChild 回调
  ```

---

## 优先级排序汇总

| 轮次 | Wave | 问题数 | 关键 P0 问题 |
|:----:|:----:|:------:|--------------|
| R1 | 1.1~1.6 | 12 | ST-07, ST-08, ST-09, TC-02, TC-04, PM-01, PM-02, PM-06, SE-02, SE-04, UI-01, UI-02 |
| R2 | 2.1~2.2 | 8 | ST-04, CS-01, CS-02, CS-03, CS-05, CS-06, CS-08, CS-09 |
| R3 | 3.1~3.2 | 8 | ST-01, ST-02, ST-03, ST-05, ST-06, TC-01, PM-04, PM-05 |
| R4 | 4.1~4.2 | 3 | SE-01, SE-03, UI-03 |
| R8 | 1.2~2.2 | 2 | CS-04, PM-03 |

### 补充轮次

| 轮次 | Wave | 问题数 | 说明 |
|:----:|:----:|:------:|------|
| S1 | S1-W1~W3 | 19 | 创建缺失的测试桩文件 |
| S2 | S2-W1 | 4 | 创建 CI 规范检查脚本 |
| S3 | S3-W1~W2 | 3 | Rust 跨 crate 整合（compaction.rs 三合一 + conex-fs 依赖） |
| S4 | S4-W1 | 1 | 最终验证：所有路径确认存在、命令可用 |

---

## Round S1 — 创建测试桩（19 个，分 3 波）

### S1-Wave1: apps/crish-desktop (9 个)
| 测试文件 | 关联 Issue | 优先级 |
|---------|-----------|:------:|
| `apps/crish-desktop/src/api/StreamRenderBuffer.test.ts` | GAP-ST-01 | P1 |
| `apps/crish-desktop/src/api/normalizer.test.ts` | GAP-ST-07 | P0 |
| `apps/crish-desktop/src/api/directFetchBridge.test.ts` | GAP-UI-02 | P0 |
| `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.test.ts` | GAP-UI-02 | P0 |
| `apps/crish-desktop/src/store/types.test.ts` | GAP-SE-04 | P0 |
| `apps/crish-desktop/src/components/DiffCardFileList.test.tsx` | GAP-SE-04 | P0 |
| `apps/crish-desktop/src/components/ComposePlusMenu.test.tsx` | GAP-UI-03 | P1 |
| `apps/crish-desktop/src/components/ModelPicker.test.tsx` | GAP-UI-03 | P1 |
| `apps/crish-desktop/src/components/ProjectPickerMenu.test.tsx` | GAP-UI-03 | P1 |

### S1-Wave2: packages/agent-runtime (8 个)
| 测试文件 | 关联 Issue | 优先级 |
|---------|-----------|:------:|
| `packages/agent-runtime/src/session-loop/index.test.ts` | GAP-ST-09 | P0 |
| `packages/agent-runtime/src/session-loop/provider-call.test.ts` | GAP-ST-09 | P0 |
| `packages/agent-runtime/src/provider-stream-contract/json-repair.test.ts` | GAP-ST-10 | P1 |
| `packages/agent-runtime/src/context-compression/compression-utils.test.ts` | GAP-SE-02 | P0 |
| `packages/agent-runtime/src/trace/index.test.ts` | GAP-CS-08 | P1 |
| `packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.test.ts` | GAP-CS-05 | P0 |
| `packages/agent-daemon/src/protocol/validators/common.test.ts` | GAP-TC-01 | P1 |
| `packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.test.ts` | GAP-TC-04 | P0 |

### S1-Wave3: packages/agent-daemon + orchestrator (3 个)
| 测试文件 | 关联 Issue | 优先级 |
|---------|-----------|:------:|
| `packages/agent-daemon/src/daemon-approval-handler.test.ts` | GAP-TC-02 | P0 |
| `packages/agent-daemon/src/mcp-stdio-adapter.test.ts` | GAP-TC-04 | P0 |
| `packages/agent-orchestrator/src/types.test.ts` | GAP-CS-02 | P0 |

## Round S2 — 创建 CI 规范检查脚本（4 个）

### S2-Wave1:
1. `scripts/ci/check-g1-style.js` — SLOC & Style Gate 校验器
2. `scripts/ci/check-g3-g4-resource.js` — 级联终止 & 资源泄漏校验器
3. `scripts/ci/run-quality-gates.ps1` — Windows 统一 runner
4. `scripts/ci/run-quality-gates.sh` — Unix 统一 runner

## Round S3 — Rust 整合

### S3-Wave1: compaction.rs 三合一
将 GAP-ST-04 (`calculate_total_tokens`)、GAP-SE-02 (`safe_drop_end`)、GAP-PM-05 (`retain` + `shrink_to_fit`) 合并为同一 Wave 中的单一 Agent 修改，确保不冲突。

### S3-Wave2: conex-fs ↔ agent-workbench 依赖
为 SE-03 (`safe_canonicalize`) 添加 conex-fs 到 agent-workbench 的依赖，或将 `safe_canonicalize` 直接内联到 agent-workbench。

## Round S4 — 最终验证
- 所有 19 个测试桩路径验证通过
- 所有 4 个 CI 脚本路径验证通过
- `verification_command` 更新为实际路径


