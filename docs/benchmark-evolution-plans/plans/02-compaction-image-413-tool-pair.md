# 02 — Compaction：IMAGE_TOKEN_COST · 413 Payload Scrub · Tool 成对门控

**Directions**: B + C  
**来源**: `docs/benchmark-evolution-plans/audits/00-master-findings.md`  
**日期**: 2026-07-22  
**原则**: 自然融入 agent-runtime + conex-compaction；禁止照抄 jcode 文件树；无 TUI；不改 softDeny / TrustZone 主语义

---

## 0. 问题一句话 + 硬证据

**一句话**：多模态图不进压缩估算且无 413 救援；TS 压缩已有 tool 成对 guard 但未导出、测试薄，Rust 盲 `remove(1)` 可切对。

| 证据 | 路径 |
|------|------|
| 图不计入 tokens | `packages/agent-runtime/src/context-compression.ts` `estimateMessageTokens` 只扫 blocks |
| 无 413 分类 | `provider-openai-compatible.ts` classify 无 payload-too-large |
| session 仅 transient 重试 | `agent-session-loop.ts` streaming error 分支 |
| Rust 图价 500 | `crates/conex-compaction/src/compaction.rs` |
| 私有 pair guard | `includeRequiredToolCallMessages`（未 export） |
| softDeny 禁区 | `isSoftOrNonFatalToolError` / 审批超时路径 **不得回归** |

---

## 1. 目标架构

```
contentParts images
    → estimateMessageTokens += N * IMAGE_TOKEN_COST(1600)
    → shouldCompress 更早更真

provider 413 / request_too_large
    → kind: payload-too-large  (非 blind transient)
    → scrubImagesOldestFirst (写回 conversation)
    → retry ≤2  (独立计数器)
    → 永不走 softDeny 工具路径

findFirstKeptMessageIndex
    → safeCompactionCutoff (export)
Rust CompactionEngine
    → IMAGE_TOKEN_COST=1600 + role-batch 安全删除
可选: request projection orphan tool_result 修复
```

### softDeny 隔离契约

| 允许 | 禁止 |
|------|------|
| 改 user `metadata.contentParts` | 把 413 写成 softDeny tool-result |
| 独立 `payloadRecoveryRetries` | 并入 502 盲重试不 scrub |
| 压缩 cutoff / 投影修复 | 删除合法 softDeny tool-result |

---

## 2. 非目标

- TUI、TrustZone 重写、桌面 1.5MB 降采样重做  
- base64/4 当地真 token  
- 413 与 context-length 混淆分类  

---

## 3. 多轮多 Agent 计划

### Round 1 — 契约与纯函数（≥4 Agent）

| Agent | 职责 | 文件 |
|-------|------|------|
| 1-Types | `ProviderErrorKind` += `payload-too-large` | `packages/shared-types` |
| 1-CompactionAPI | `IMAGE_TOKEN_COST`、`countMessageImages`、`estimateMessageTokens`、export `safeCompactionCutoff` | `context-compression.ts`（**单 Owner**） |
| 1-Classify | HTTP 413 + 文案分类；`4130` 不命中 | `provider-openai-compatible.ts` + base 分叉 |
| 1-PureTests | 图估算 / cutoff / classify 厚测 | `*.test.ts` |

**闸门 G1**: 有图 ≥1600；safeCompactionCutoff 可 import；413 分类正确；softDeny 测全绿。

### Round 2 — 413 接线 + Rust（≥4 Agent）

| Agent | 职责 | 文件 |
|-------|------|------|
| 2-ScrubLib | `scrubImagesOldestFirst` + 占位文案；**新 message 对象**防 WeakMap 脏缓存 | 新建 `payload-image-recovery.ts` |
| 2-Session413 | session-loop 专用分支 MAX=2；diagnostic phase | `agent-session-loop.ts` |
| 2-RustCostGate | 1600 + role-batch 安全删 | `crates/conex-compaction` |
| 2-SessionTests | mock 413→success；无图可 scrub 时有限失败 | `agent-session-loop.test.ts` |

**闸门 G2**: 413 救援绿；502 路径不变；cargo test conex-compaction 绿。

### Round 3 — P2 投影 + 收口（≥4 Agent）

| Agent | 职责 |
|-------|------|
| 3-OpenAIPair | 投影层 orphan tool_result |
| 3-AnthropicPair | 同上 |
| 3-CrossRegression | softDeny / compression 回归 |
| 3-Docs | 勾 DoD；链接 master findings |

**闸门 G3**: §4 DoD 全勾。

---

## 4. 测试与 DoD

- [ ] 大 base64 图估算 ≈ N×1600 非 100k+  
- [ ] payload-too-large 分类 + scrub 重试  
- [ ] safeCompactionCutoff 导出 + jcode 级边界测  
- [ ] Rust 无孤立 tool 角色序列  
- [ ] softDeny / 审批超时 **零回归**  

```text
pnpm exec vitest run packages/agent-runtime/src/context-compression.test.ts
pnpm exec vitest run packages/agent-runtime/src/agent-session-loop.test.ts
cargo test -p conex-compaction
```

---

## 5. 风险

| 风险 | 缓解 |
|------|------|
| WeakMap 脏缓存 | scrub 必须新对象 |
| 413 被 400 抢匹配 | 分类顺序优先 payload |
| 无限循环 | MAX_PAYLOAD_RECOVERY=2 |

---

## 关键路径

- `packages/agent-runtime/src/context-compression.ts`  
- `packages/agent-runtime/src/agent-session-loop.ts`  
- `packages/agent-runtime/src/provider-openai-compatible.ts`  
- `crates/conex-compaction/src/compaction.rs`  
- `packages/shared-types/src/tool.ts`  
