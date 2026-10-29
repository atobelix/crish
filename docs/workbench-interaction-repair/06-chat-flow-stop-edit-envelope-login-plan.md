# 对话流交互修复分维详案：停止即时性 / 编辑重发语义 / 状态信封 SSOT / 登录入口 / 探活加固

> **战役工作区**：`docs/workbench-interaction-repair/`
> **上游勘察**：[`audits/07-第二轮问题发现-停止编辑信封探活登录.md`](./audits/07-第二轮问题发现-停止编辑信封探活登录.md)（根因与证据）
> **性质**：方案分维度实现文档（分维详案）；文件级改动清单 + 不变量 + 验收断言
> **日期**：2026-10-29

---

## 维度 A：L2 协作停止流中即时生效（引擎）

**目标不变量**：L2 请求到流停止的延迟 ≤ 1 个 chunk；停止保留已收内容；run 终态 `stopped`（不触发自动续轮，D1 语义不变）；L3 行为不变。

| 文件 | 改动 |
|------|------|
| `crates/session-loop/src/control.rs` | `ControlBus` 新增恒有字段 `stop_signal: AbortSignal`（复用 safe_point 原语：AtomicBool + Notify，Clone 即共享触发面）；`request_cooperative_stop` 入队后触发该信号；新增 `stop_signal()` 只读访问 |
| `crates/session-loop/src/loop/handlers/mod.rs` | `LoopState` 新增 `stop_signal: AbortSignal`（`new()` 默认 `AbortSignal::new()`） |
| `crates/session-loop/src/loop/loop_runner.rs` | `with_control_bus` 注入总线时同步从总线拉取 `stop_signal` 克隆入 state（壳层与内核共享同一触发面，零壳层改动） |
| `crates/session-loop/src/loop/handlers/streaming.rs` | `consume_stream` 的 `tokio::select!`（biased）新增第三分支竞速 `stop_signal.wait_aborted()` → 置 `cooperative_stopped` 立即 break；补 Q33 式竞速窗口复查；`ConsumeOutcome` 新增 `cooperative_stopped`；`handle` 流错误分支与 `consume_classify` abort 分支并入该标记 → 复用 `streaming_aborted`（其总线 drain 命中 CooperativeStop → `EndDecision::stopped`，pending 消息回 steer 环——现成收场路径零重复） |

**收场语义对账**：中断的工具调用合成（`synthesize_and_record_interrupted_calls`）与 abort 路径同款；部分文本已 commit（abort 分支前已 commit）；无正文时走 `stream_error` 分支同样以 stopped 收场而非重试。

**测试**：control.rs 单测（请求触发信号）；loop 级测试镜像「流中 abort」用例——挂起的 provider 流 + 并发 `request_cooperative_stop` → 断言 stopped 终态、部分文本落盘、无工具误执行。

## 维度 B：编辑重发一等化（前端）

| 文件 | 改动 |
|------|------|
| `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | `finalizeStopGeneration` 增加 `opts?: { silent?: boolean }`；silent 抑制两处 stop toast；导出 `handleSilentStopGeneration` |
| `apps/crish-desktop/src/components/chat-card/useChatHandlers.ts` | `handleEditMessageAndResend` 改调 silent 停止（停止是手段，不再冒充用户可见语义） |

**语义决策（记录）**：编辑 = fork 截断重发（与主流一致，保持现引擎 retract 语义）；被截断后缀随旧分支消失；误导性「已停止任务并清空排队。」toast 不再出现在编辑流。

## 维度 C：状态信封 SSOT（前端 + 引擎）

**单一真理路径**：正文只存用户原文；context_state 仅经结构化参数（`contextState`，已存在）传引擎，在**请求组装期**合并（LLM 可见）；呈现只走 `ContextStateNotice` 发丝线。

| 文件 | 改动 |
|------|------|
| `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` | 删除 `finalUserDisplayText` 信封拼装；`addMessage` 存 `displayText` 原文；`contextState` 结构化参数保留 |
| `apps/crish-desktop/src/hooks/chat-stream/slashSendQueueHelper.ts` | 同上，删除 `:164` 拼装 |
| `apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx` | 删除信封附段渲染（(b) 块）与结构化双段布局；`parseStructuredUserText` 降级为**存量消息只读视图剥离**（渲染/复制只见用户原文）；⏰ Emoji → `AppIcon` 时钟图标 |
| `apps/crish-desktop/src/components/chat-card/ChatCard.tsx` | 编辑预填改用 `parseStructuredUserText(targetMsg.text).userInputText`（存量消息洗白入口） |
| `crates/conex-run/src/run/run_launch.rs` | `:1483` 合并逻辑保留（请求组装期，`contains` 幂等守卫适配前端已不再拼装的新态）——落库正文不经此路径者核实并注释锚定 |

**存量兼容口径**：不迁移数据；`parseStructuredUserText` 保留为唯一读侧剥离点（渲染 + 编辑预填），新消息正文不再产生信封标记，存量随重发自然洗白。

## 维度 D：账户登录入口（前端）

| 文件 | 改动 |
|------|------|
| `apps/crish-desktop/src/app/AppGlobalDialogs.tsx` | 根级单实例挂载 `<AccountCenterDialog />` |
| `apps/crish-desktop/src/components/settings/AccountAuthCard.tsx` | 移除本地 `AccountCenterDialog` 挂载；登录按钮从 `variant="unstyled"` + 私有 class 改为全局原子 `Button`（primary variant / 设计 token） |
| `apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx` | 未登录头像点击 → `openLogin()` 直登；已登录保持跳账户概览 |

## 维度 E：探活与请求加固（Rust；与并行会话文件域核对后执行）

| 文件 | 改动 |
|------|------|
| `crates/agent-provider/src/request/wire_protocol.rs` | `build_endpoint_url` OpenAiChat / OpenAiResponses 改为通用归一（未含版本段补 `/v1`），删除 sensenova.cn / openai.com 域名特判；同步更新单测 |
| `apps/agent-workbench/src-tauri/src/probe.rs` | 移除两处 `.no_proxy()` 硬编码（默认跟随系统代理，`provider.proxy_url` 显式配置仍优先），与引擎主链路（`connection.rs`）行为对齐 |
| 引擎流错误格式化点（`crates/conex-run/src/engine_provider/`内定位「服务端错误（HTTP …）」） | 透传响应体摘要（≤200 字符，密钥脱敏复用探活同款 replace），错误分类区分 401 / 404 / 5xx |

## 收口与测试策略

- 集中测试（改完 A–E 后一次跑）：`cargo test -p session-loop -p conex-run -p agent-provider` + 前端 `npm run typecheck` + `npm run test -- --project=unit`（触域文件对应单测先行修复）。
- 真机验收（Tauri MCP）：停止即时性 / 编辑观感 / 信封消失 / 直登弹窗 / 探活错误透传（gpt-6-luna 503 时应显示服务端原始原因）。
- 提交：主 Agent `git commit --only` 按维度分批；与并行会话（provider 体系重构）共touch文件（`ChatCard.tsx`、`AppGlobalDialogs.tsx`）提交前核对内容完整性。
