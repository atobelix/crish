# 04 — Search 常驻索引 · 4D 成本 · 轻量 Secret Sidecar

**Directions**: E + I + F
**来源**: `docs/benchmark-evolution-plans/audits/00-master-findings.md`
**日期**: 2026-07-22
**硬约束**: 无 TUI；无沙箱重写；**禁止** jcode DP 作 100k 默认；密钥 **轻量**（DPAPI 多 profile，非 daemon 磁盘库）

---

## 0. 问题一句话 + 硬证据

| 方向 | 现状 | 缺口 |
|------|------|------|
| E | score-only + Rayon 已有；Tauri `SearchHandler.files` **常空**；无 UI 调 `core_search_files` | 常驻 GlobalIndex + query-only IPC + top-K + Ctrl+P |
| I | metrics/snapshot.**cache** 已有 | `fetchRunSnapshotUsage` **丢掉** cache；pricing/UI 仅 2D |
| F | 多 profile **明文 LS**；workbench 单槽 DPAPI | 多 id secret map + LS 去密钥 |

---

## 1. 目标架构

```
E: walker → GlobalIndex(ArcSwap)
   core_search_files { query, limit }  // 无 files[]
   top-K score-only → materialize hits
   Ctrl+P QuickOpen → openFileInPanel

I: snapshot.usage + snapshot.cache
   → hydrate 4D → pricing 4 rates → $ Saved UI

F: LS profiles 仅元数据 + hasKey
   Tauri secrets/{profileId}.dpapi
   activate/boot → secret_get → update-config
   daemon 仍仅内存
```

### 4D 估算公式（展示用）

```
nonCachedInput = max(0, promptTokens - cacheReadTokens)
cost = nonCachedInput*Pin + completion*Pout + cacheWrite*Pcw + cacheRead*Pcr
fullPriceIfNoCache = promptTokens*Pin + completion*Pout
savings = max(0, fullPriceIfNoCache - cost)
// Pcr 默认 ≈ 0.1*Pin；Pcw 默认 ≈ 1.25*Pin（可配置）
```

---

## 2. 非目标

- 全文代码索引 / DP 全库打分
- keyring crate 全平台大工程（可后置）
- daemon 持久化密钥

---

## 3. 多轮多 Agent 计划

### Round 0 — 契约（≥4 Agent）

IPC 搜索契约 · 4D 类型 · secret 命令 · 测试矩阵。

### Round 1 — 地基（≥4 Agent）

| Agent | 工作 |
|-------|------|
| R1-A Index | GlobalIndex + rebuild + query-only handler |
| R1-B Top-K | BinaryHeap/select_nth；unicode score-only |
| R1-C Hydrate | `fetchRunSnapshotUsage` 透传 cache |
| R1-D Secrets API | multi-profile DPAPI map（credentials.rs） |

**闸门**: cargo conex-search；hydrate fixture 含 cache；双 profile secret 不互盖。

### Round 2 — 接线（≥4 Agent）

| Agent | 工作 |
|-------|------|
| R2-A Tauri | State 常驻索引；core_rebuild_index |
| R2-B pricingStore | 4 价 + savings |
| R2-C usageStore + TokenUsage | 4D 桶 |
| R2-D providerProfiles | secret_set + strip LS apiKey + migrate |

**闸门**: 真 workspace 搜索有命中；LS 无明文 key。

### Round 3 — UI（≥4 Agent）

| Agent | 工作 |
|-------|------|
| R3-A QuickOpen | Ctrl+P 面板 |
| R3-B Index lifecycle | 开仓 rebuild |
| R3-C Overview/Runtime | cache + $ Saved |
| R3-D SettingsUsage | 4 列价格 + 历史 |

### Round 4 — 硬化（≥4 Agent）

SLA bench · useChatStream 接 4D · secret UX 脱敏 · 文档。

---

## 4. DoD

### E
- [ ] 常驻索引；query 不传 files[]
- [ ] top-K ≤ limit；无 DP 全库
- [ ] Ctrl+P 打开文件

### I
- [ ] hydrate 含 cache
- [ ] 4 价 + $ Saved 可见
- [ ] 无 cache 时 2D 降级

### F
- [ ] 多 profile DPAPI；LS 无 apiKey
- [ ] boot hydrate engine
- [ ] daemon 仍内存

---

## 5. 风险

| 风险 | 缓解 |
|------|------|
| 索引卡 UI | spawn_blocking + is_indexing |
| cache 双计 | 公式单测 + 文档 |
| 迁移残留 LS | load 时 strip |

---

## 关键路径

- `crates/conex-search/src/search.rs` / `handlers/*`
- `apps/agent-workbench/src-tauri/src/core_commands.rs`
- `apps/crish-desktop/src/api/sessionEventHydrate.ts`
- `pricingStore.ts` / `usageStore.ts` / `providerProfiles.ts`
- `credentials.rs`
