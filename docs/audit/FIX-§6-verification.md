# §6 修复抽查 · FIX-§6-verification

> 核查人：code-audit · 2026-09-08（America/New_York）
> 标准：`QUALITY-GATE.md` 可证伪
> 对照：`FIX-PROGRESS-§6.md`（含续节）· 前置 §5 已闭合

## 总裁定：**有条件通过**（无功能阻断 `[!]`；门禁挂名 `[~]`）

| 小节 | 标记 | 说明 |
|------|:----:|------|
| §6.1 写必可读回 | `[x]` | 生产 effect 调 `loadEmergencyDraftSync`；Panel 叠字展示 |
| §6.2 flush 形式化排空 | `[x]` | 无 `pass < 2`；至空或 throw；`MAX_DRAIN_ROUNDS=64` |
| §6.3 生产块 ID crypto | `[x]` | PROD 硬失败；弱熵仅 DEV/test helper |
| 门禁 `check-sec6-note-drain-entropy` | `[~]` | 脚本独立 **SEC6 PASS**；**尚未**进 `package.json`/`check:desktop` |

**正式闭合条件**：把 `check-sec6-note-drain-entropy` 挂入桌面总闸（main 自报补挂名）。
**§7**：摸查/落地不因本 `[~]` 阻断；§9.7 全量应急草稿引用扫描属 §9，本轮不要求。

---

## §6.1 `[x]` 写必可读回

**证据**

- `useNoteTextPersistence.ts`：`beforeunload` → `saveEmergencyDraftSync`；hydrateReady effect → `const drafts = loadEmergencyDraftSync(docId)`；`if (!hydrateReady) return`。
- 与磁盘一致 → `clearEmergencyDraftSync` + `setEmergencyDrafts(null)`；有差异 → `setEmergencyDrafts(pending)` + `scheduleBlockText`（**不**回灌权威 `blocks`）。
- `overlayEmergencyDraftTexts` 纯函数叠字。
- `NotePaperStrictPanel`：`hydrateReady = status === 'ready' \|\| status === 'empty'`；`displayBlocks = overlayEmergencyDraftTexts(...)` 传 Header/Body。
- flush 成功清空 pending 时同步 `clearEmergencyDraftSync` + `setEmergencyDrafts(null)`（约 L278–280 / L310–312）。

**测试**：`useNoteTextPersistence.sec6.source.test.ts` 锁生产调用与 Panel 接线（非仅 export）。

---

## §6.2 `[x]` flushPendingDraft 排空

**证据**

- 已删固定两轮 `pass < 2`。
- `MAX_DRAIN_ROUNDS = 64`；覆盖 `pendingFlushRef` / `blockQueueRef` / `inFlightBlocksRef`。
- 空则 `return`；停滞 → `unsaved` + throw `drain stalled`；触顶 → throw `exceeded`。

**门禁脚本**：`scripts/check-sec6-note-drain-entropy.mjs` 静态断言上述契约 → 本机 **PASS**。

---

## §6.3 `[x]` 块 ID 生产熵

**证据**

- `noteBlockId.ts`：优先 `crypto.randomUUID`，否则 `getRandomValues` → UUID v4。
- `import.meta.env.PROD` 缺熵硬抛；弱熵仅 `fillWeakEntropyForDevOnly`，且仅 `DEV \|\| MODE === 'test'`。
- `newNoteBlockId` 函数体内无直接 `Math.random`（隔离在 helper）。

**门禁脚本**：同脚本第二项 → **PASS**。

---

## 本机复跑

| 命令 | 结果 |
|------|------|
| `node scripts/check-sec6-note-drain-entropy.mjs` | **SEC6 PASS** |
| vitest：Persistence 行为/§6.1 源码 + flush 源码 + noteBlockId 源码/行为（5 files） | **19 passed** |

---

## QUALITY-GATE 对照

1. 意图可陈述 — 过（§6.1–6.3）
2. 无新旁路 — 过（单套 storage；无生产弱熵轨；无伪两轮 flush）
3. 对称失败 — 过（loading 不读回；排空/缺熵 throw）
4. 测试非假绿 — 过（行为 + 源码契约）
5. 门禁可执行 — **部分**：脚本可跑绿；**总闸未接线 = 未完成**（记 `[~]`）
6. 二次核查 — 本文件；**无功能 `[!]`**

---

## 结论与交接

- **§6 有条件通过**：6.1 / 6.2 / 6.3 代码与专项测过关。
- **@main**：请将 `check-sec6-note-drain-entropy` 挂入 `check:desktop`（或等价总闸）后喊一声，verification 该项 `[~]`→`[x]` 即可标 **§6 闭合**。
- §9.7 引用扫描仍归 §9。
- §7 可继续。

_文档由 code-audit 可证伪抽查生成_