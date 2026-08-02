# 幻觉/偏差问题清单

> 包含：路径幻觉条目 + 根因偏差条目 + 修复方案偏差条目

---

## 一、路径幻觉（文件不存在）

### 1. GAP-ST-01 — StreamRenderBuffer.test.ts
- **原路径**: `apps/crish-desktop/src/api/StreamRenderBuffer.test.ts`
- **类型**: 路径幻觉
- **错误原因**: 该测试文件在原路径不存在。自动纠偏后发现实际文件位于 `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts`
- **建议处理**: 修正 `v2_cross_index.json` 中的 `files_read` 路径，或确认该文件是否应为新建测试文件（原文档计划中可能预期新建）

### 2. GAP-09-01 — seek_parity.rs
- **原路径**: `crates/conex-diff/tests/seek_parity.rs`
- **类型**: 路径幻觉
- **错误原因**: `crates/conex-diff/tests/` 目录完全不存在。该文件为 R9 计划测试文件，尚未创建
- **建议处理**: 标记为计划新建文件，在 `write_set_isolation_matrix_v2.md` 中标注 `[NEW]`

### 3. GAP-09-02 — chatgpt-pool.test.ts
- **原路径**: `packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.test.ts`
- **类型**: 错误路径（wrong_path）
- **错误原因**: 实际文件位于 `packages/agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts`
- **建议处理**: 修正为实际路径

### 4. GAP-09-03 — compaction-pair.test.ts
- **原路径**: `packages/agent-runtime/src/context-compression/compaction-pair.test.ts`
- **类型**: 路径幻觉
- **错误原因**: 文件在全仓库任何位置均不存在，为 R9 计划测试文件
- **建议处理**: 标记为 `[NEW]` 计划新建文件

### 5. GAP-09-04 — full-system.test.ts
- **原路径**: `tests/e2e/full-system.test.ts`
- **类型**: 路径幻觉
- **错误原因**: 文件在全仓库任何位置均不存在，为 R9 计划测试文件
- **建议处理**: 标记为 `[NEW]` 计划新建文件

---

## 二、根因偏差条目（问题真实，但描述有偏差）

### 1. GAP-CS-07 — 账号池将暂态流中断误判为 Auth 错误
- **根因状态**: ⚠️ partial
- **偏差说明**: 实际风险路径并非 `StreamRecoveryError` 直接触发 `chatgpt-pool.recordFailure()`，而是 `stream-recovery` 的 `surface-error` 路径丢失了原始错误类型信息，导致上层按 UNKNOWN 处理。缺失的不是分类器而是分类信息在错误传递链中的保真度。
- **建议处理**: 修正原文档描述，将修复重点从"扩展 account pool 错误类型"调整为"确保 `StreamRecoveryError` 携带原始错误域信息"

### 2. GAP-TC-03 — Tool 消息体空 content 序列化
- **根因状态**: ⚠️ partial
- **偏差说明**: `stringifyToolOutput` 有两个实现：`openai-request-build.ts` 使用 truthy 检查（有 bug），`tool-output-budget.ts` 使用 typeof 检查（无此问题）。根因描述未区分两个版本。
- **建议处理**: 修正描述，仅 `openai-request-build.ts` 版本需要修复；`safeToolResultContent` 为提案函数名，不存在现有代码

### 3. GAP-PM-02 — terminateProcessTree 缺乏两阶段优雅终止
- **根因状态**: ⚠️ partial
- **偏差说明**: Unix 分支已具备两阶段终止（`SIGTERM` → `scheduleKillEscalation` 5s → `SIGKILL`）且 `detached: true` 已设进程组 leader。问题描述称"Unix 分支缺乏进程组 leader 设置"不准确。
- **建议处理**: 缩小修复范围——仅 Windows 分支需要 Phase 1 软杀阶段；Unix 分支已在正确状态

### 4. GAP-SE-02 — 上下文压缩缺乏工具对绑定
- **根因状态**: ⚠️ partial
- **偏差说明**: Rust `safe_drop_end` 并非完全"缺乏工具对绑定"——已有 role 级邻接保护（assistant + 连续 tool），缺少的是跨消息的 ID 级配对断言。TS `includeRequiredToolCallMessages` 已有正向追溯，缺少反向追溯。`serializer.ts` 不参与裁切决策。
- **建议处理**: 修正描述——不对函数整体否定，而是说明"role 级保护已存在，需增加 ID 级跨消息配对断言"

### 5. GAP-UI-04 — API Key 非 Windows 加密为空 + 前端 localStorage 凭据泄漏
- **根因状态**: ⚠️ partial
- **偏差说明**: localStorage 明文存储 apiKey 的描述与当前代码不符——`saveProfiles` 已通过 `stripApiKey` 剥除 apiKey。但非 Windows 平台加密缺位完全属实。另外 `oauthToken` 被 `normalizeProviderProfile` 静默丢弃，存在数据丢失 bug。
- **建议处理**: 修正 localStorage 描述（改为已剥除），保留非 Windows 加密修复方向；新增 `oauthToken` 数据丢失 bug 修复

---

## 三、修复方案偏差条目（原修复方案需校正）

### 1. GAP-ST-10 — balanceJsonContainers 修复
- **偏差类型**: 修复方案夸大
- **偏差说明**: 原方案称"ProviderResponseConsumer 主干未集成修复器"，但根因审计发现 `repairToolCallJsonArguments` 已通过上游 `ProviderToolCallJsonAccumulator.finalize()` 集成。Consumer 层已经收到 pre-repaired input。
- **校正**: 移除 ProviderResponseConsumer 集成部分；保留 balanceJsonContainers 的尾随反斜杠剥离和截断字面量补全修复

### 2. GAP-CS-05 — CrossProcessLock 方案偏重
- **偏差类型**: 方案选择偏差
- **偏差说明**: 原方案推荐 `CrossProcessLock`（文件锁），但同一 ChatGPTAccountPool 实例不存在跨进程争用。文件锁开销大且可能残留死锁。
- **校正**: 改为同进程 `AsyncMutex` single-flight Promise 去重方案，更轻量且避免文件锁问题

### 3. GAP-ST-09 — 误判 session-loop 缺乏 length 处理逻辑
- **偏差类型**: 方案方向偏差
- **偏差说明**: 原方案认为 `handleNoToolCalls` 缺乏 length 处理逻辑，但根因审计发现已有完整实现（`handleLengthFinishReason`、`tryEscalateMaxTokensForLengthRecovery`），问题仅在于上游信号丢失导致路径不可达。
- **校正**: 移除 session-loop 修改项；ST-07+ST-08 修复后该路径自动可达

---

## 四、写集矩阵路径修正摘要（write_set_isolation_matrix_v2.md）

以下路径在 write_set 矩阵中引用错误，需要在文档中同步修正：

| 原路径 | 修正路径 | 问题 |
|--------|----------|------|
| `apps/crish-desktop/src/utils/approval-cache.ts` | `packages/agent-runtime/src/approval/approval-cache.ts` | wrong_path |
| `apps/crish-desktop/src/services/approval-pipeline.ts` | `packages/agent-runtime/src/approval/approval-pipeline.ts` | wrong_path |
| `apps/crish-desktop/src/services/stream-recovery.ts` | `packages/agent-runtime/src/provider-transport/stream-recovery.ts` | wrong_path |
| `apps/crish-desktop/src/services/approval-bridge.ts` | `packages/agent-daemon/src/server/approval-bridge.ts` | wrong_path |
| `apps/crish-desktop/src/services/approval-queue.ts` | `packages/agent-daemon/src/approval-queue.ts` | wrong_path |
| `packages/shared-types/src/protocol-inbound.ts` | `packages/agent-daemon/src/types/protocol-inbound.ts` | wrong_path |
| `crates/conex-ipc/src/process.rs` | `crates/conex-sandbox/src/process_tree.rs` | wrong_path（应删除，文件不存在） |
| `packages/agent-provider-http/src/provider-registry-v2.ts` | 不存在 → 应删除 | 幻觉文件 |
| `apps/crish-desktop/src/workers/pretextWorker.ts` | 不存在 → 应删除 | 幻觉文件 |

---

## 五、治理配置幻觉（Quality Gates 文档）

| 条目 | 问题 | 建议 |
|------|------|------|
| QG-G1-script | `scripts/ci/check-g1-style.js` 不存在，需从文档内嵌源码提取创建 | 创建脚本，补充 forbiddenPatterns 至 9 条 |
| QG-G3-G4-script | 同上，`check-g3-g4-resource.js` 不存在 | 创建脚本，修复 G4 死代码和 G3 竞态 |
| QG-G5-config | `vitest.e2e.config.ts` 不存在 | 新建或改用现有 `vitest.integration.config.ts` |
| QG-runner-scripts | `scripts/ci/run-quality-gates.ps1/.sh` 不存在 | 创建脚本，修复 PowerShell 拼写错误 |
| QG-coverage-80 | 文档称覆盖率 >80%，但实际阈值远低于此 | 修正文档描述，匹配实际 vitest 配置 |
| QG-gatekeeper-count | 文档称 11 条红线，实际 gatekeeper.rs 有 17 条 | 同步修正计数 |
| QG-sab-ring-buffer | Wave 1 计划移除但未完成 | 补充说明此任务仅标记了计划 |
| QG-anti-overengineering-count | 文档声明 10 项禁令，实际 9 条 | 修正计数或补充第 10 条 |
