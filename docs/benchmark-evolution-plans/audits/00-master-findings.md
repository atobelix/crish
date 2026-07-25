# Benchmark Evolution — 10 路专项审计汇总

**日期**: 2026-07-22  
**方法**: ≥10 路 read-only Agent 对照 `reference/`（Opencode / jcode / codex-cli / Claude Code）与 Conex 现码  
**用户硬约束**:
- **禁止** 照抄 reference；必须自然融入 Conex 架构（Rust crates + agent-runtime + daemon + crish-desktop）
- **不做** TUI
- **不重做** 沙箱 / TrustZone 体系（现状策略可接受，安全仅轻量）
- 优先：**编辑容错、压缩健壮、流式体验、运行恢复、成本可见**

**参考仓库**（均在 `reference/`）: opencode · jcode · codex-cli · claudeCode  
**本机强项**（审计确认，勿重复造轮）: Myers `conex-diff` 展示 · Rayon 文件搜索 · CQRS 事件快照 · 5 级 TrustZone · 64KB/16KB 流反压 · softDeny 主路径

---

## 0. 判定总表（自然融入优先级）

| ID | 方向 | Conex 现状 | 标杆 | 优先级 | 自然挂载点 |
|----|------|------------|------|--------|------------|
| A | 4 级模糊 Hunk Seek | Myers 展示 + **精确** apply + **行号** edit | codex 4-pass / opencode | **P0** | `conex-diff` 新模块 + `fs-edit` / `applyFileDiff` |
| B | 图片 Token + 413 救援 | 图不计入压缩；无 413 分支 | jcode IMAGE_TOKEN_COST=1600 | **P0** | `context-compression` + session-loop |
| C | Tool 成对截断 | **TS 已有**私有 guard；Rust 无 | jcode `safe_compaction_cutoff` | **P1** | 导出 + Rust 门控 + request 修复 |
| D | 流式 Patch 状态机 | 仅工具成功后 Diff | codex StreamingPatchParser | **P1** | args-delta 事件 + 渐进 Diff UI |
| E | 搜索 0 堆打分 | 已有 score-only + Rayon；UI 未接 | jcode PositionSummary（小 N） | **P1** | 常驻索引 + top-K + quick-open |
| F | OS Keyring | 桌面 **明文 LS**；workbench 单槽 DPAPI | codex keyring Auto | **P2**（轻安全） | 多 profile secret sidecar |
| G | Anthropic ephemeral 缓存锚点 | **仅 plan** 无 wire | Claude Code cache_control | **P0** | `anthropic-request-build` |
| H | Denial 追踪 | softDeny 无 intent 拒绝记忆 | Claude denialTracking（语义不同） | **P1** | 拒绝记忆 + 信封文案 |
| I | 4 维 Token / USD | 运行时有 cache 字段，UI 丢弃 | Claude cost-tracker | **P1** | hydrate + pricingStore |
| J | `/doctor` `/init` + max_tokens 阶梯 | 无 slash；length 被 consumer 抹掉 | Claude doctor/init/query | **P0/P1** | consumer + session-loop + slash |

---

## 1. Direction A — 模糊 Hunk / Patch 匹配

### 硬证据（Conex）
- `crates/conex-diff`: Myers 展示；**无** seek / apply_patch
- `packages/agent-runtime/.../fs-edit-tools.ts`: 行号 op；无内容 seek
- `apps/crish-desktop/src/api/applyFileDiff.ts`: EOL 规范化后 **exact** `indexOf`；多命中/上下文 hunk 拒

### 标杆
- codex-cli `seek_sequence.rs`: exact → rstrip → trim → **unicode normalize**
- opencode: 同上 + edit 多级 replacer（Levenshtein 为 **P2**，默认勿抄）
- jcode: 3 级 seek（缺 unicode）

### 缺口 Top
1. P0 无 4-pass `seekSequence` 纯函数  
2. P0 Agent 无法从行号漂移恢复  
3. P1 桌面 Accept 对真实 diff 易失败  
4. P1 无 Codex patch 文法工具  
5. P2 勿默认上 Levenshtein 静默改文件  

### 自然化
**Mutation locator** 与 Myers 展示解耦：`conex-diff/seek_sequence` 或 `conex-patch` → 被 `edit/replace_text` 与 `applyFileDiff` 消费。

---

## 2. Direction B — 图片 Token + HTTP 413

### 硬证据
- TS `estimateMessageTokens` **看不到** `metadata.contentParts` 图片 → 压缩门禁失真  
- Rust compact 用 `images.len()*500`，与 daemon 多模态路径脱节  
- 全仓 **无** 413 / payload-too-large 分类与 scrub 重试  
- 桌面有 1.5MB 单图降采样（L0），多轮累积仍可 413  

### 标杆 jcode
- `IMAGE_TOKEN_COST=1600`；413 先 scrub 图再 compact；oldest-first  

### 自然化
1. `context-compression.ts` 固定 1600/图  
2. provider 分类 `payload-too-large`  
3. session-loop：scrub `contentParts` → `[Image content omitted]` → 限次重试  

---

## 3. Direction C — Tool 成对不变性

### 硬证据
- TS `includeRequiredToolCallMessages` **已实现** jcode 语义（私有、测试薄）  
- Rust `CompactionEngine` `remove(1)` **可切断** 对  
- 无 Claude 式 request-time `ensureToolResultPairing`  

### 自然化
导出 `safeCompactionCutoff`；补测试；Rust 路径门控；可选 provider 投影层孤儿修复。

---

## 4. Direction D — 流式 Patch

### 硬证据
- Provider 内部积累 args delta，但 consumer **只 end** 工具调用  
- DiffCard 仅 `onToolSuccess` 后刷新  
- `StreamingDiffParser` / Rust `parse_stream` **未接线**  

### 自然化
args-delta 事件 →（可选）streaming SM → 节流 partial FileDiff → DiffCard「生成中」；Accept 仍终态后才开。

---

## 5. Direction E — 搜索打分

### 硬证据
- `conex-search` 已有 score-only + Rayon + prefilter；100k SLA 取向正确  
- jcode DP **不适合** 直接替换 100k 路径  
- 桌面 **无** quick-open 调用 `core_search_files`；slash 仅 prefix  

### 自然化
常驻索引 + query-only IPC + top-K + unicode score-only；小 N picker 可选 DP；接线 UI。

---

## 6. Direction F — Keyring（轻）

### 硬证据
- 产品多 profile：`providerProfiles` **明文 localStorage**  
- workbench：单槽 Windows DPAPI  
- daemon：内存 only（正确）  

### 自然化 P2
LS 只存元数据；Tauri secret map(profileId)；启动 hydrate → update-config；日后可选 keyring crate。

---

## 7. Direction G — Anthropic cache_control

### 硬证据
- `prompt-assembly` + `provider-cache-hints` 有 **plan**  
- `anthropic-request-build` **无** wire `cache_control`  
- session-loop 未传 `providerFamily` → plan 常为 unknown  

### 自然化
仅 Anthropic body：system 末块 + last tool `ephemeral`；OpenAI 路径永不污染。

---

## 8. Direction H — Denial Tracking

### 硬证据
- softDeny 主路径已通；用户拒绝文案 **弱于** 超时「改方案」  
- approve 有 intent allowlist；**deny 无** 抑制重弹  
- Recovery 把 softDeny 当普通 tool error  

### 注意
Claude `denialTracking` 是 **分类器** 拒绝计数，不是人类 Deny——借鉴形态勿照搬语义。

### 自然化
run 级 intent 拒绝记忆 → 自动 softDeny 不弹窗 + 信封 `retryable:false` + 拒绝专用 steering。

---

## 9. Direction I — 4D 成本

### 硬证据
- Anthropic 解析 cache read/write 已有；metrics/snapshot.cache 有  
- `fetchRunSnapshotUsage` **丢掉** cache  
- UI / pricing 仅 2D  

### 自然化
hydrate 透传 → pricing 4 档 → Settings/Overview 展示 $ Saved。

---

## 10. Direction J — /doctor /init + max_tokens

### 硬证据
- slash 无 doctor/init；`CONEX.md` **只读不生成**  
- `ProviderResponseConsumer` 把 `finishReason:length` **抹成 stop**  
- 文档写了 escalate，**运行时未做**  

### 自然化
1. 修 consumer finishReason  
2. escalate + 续写预算  
3. `/doctor` 组合现有 status/capabilities  
4. `/init` 会话提示写 CONEX.md  

---

## 11. 明确非目标（本演进专题）

| 非目标 | 原因 |
|--------|------|
| TUI / React Ink | 用户无计划 |
| 沙箱 / TrustZone 重写 | 现状可用 |
| 默认 Levenshtein 静默 apply | 误改风险 |
| jcode DP 替换 100k 文件搜索 | 打爆 SLA |
| Daemon 磁盘密钥库 | 宿主持密即可 |
| 完整 OAuth/account-center | 另专题 |

---

## 12. 建议落地波次（供 Roadmap）

| Wave | 主题 | IDs |
|------|------|-----|
| **W1 正确性** | Seek + Anthropic cache wire + length 恢复 + 图片 token/413 | A,G,J-T,B |
| **W2 健壮交互** | Denial 记忆 + tool-pair 导出 + 4D 成本 UI | H,C,I |
| **W3 体验** | 流式 Diff + 搜索接线 + /doctor /init | D,E,J-D |
| **W4 轻安全** | Profile secret sidecar | F |

每波 ≥4 并行 Agent；闸门：相关 vitest +（涉及 UI）软件内冒烟。

---

## 13. 审计 Agent 清单

| Agent | 方向 |
|-------|------|
| A | Fuzzy patch / seek |
| B | Image token + 413 |
| C | Tool pairing compaction |
| D | Streaming patch FSM |
| E | Fuzzy search 0-heap |
| F | Keyring light |
| G | Anthropic ephemeral |
| H | Denial tracking |
| I | 4D cost telemetry |
| J | doctor/init/max_tokens |
