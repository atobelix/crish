# FIX-PROGRESS-§6

> date 2026-09-08 (America/New_York)
> scope SYSTEMATIC-FIX-PLAN §6 第 1 项（写必可读回）+ QUALITY-GATE
> 本路**只做**应急草稿「写必可读回」；**不开** §6.2 flush 排空 / §6.3 块 ID / §7

## 意图
消除「应急草稿只写不读」伪连通：beforeunload → saveEmergencyDraftSync 已有，生产挂载/打开文档对称调用已有 loadEmergencyDraftSync，UI 可读回并可再落盘；补行为测 + 源码契约防假绿。

## §6.1 写必可读回（本项）
1. useNoteTextPersistence：hydrate 终态（hydrateReady）后对当前 docId 调用 loadEmergencyDraftSync；与磁盘一致则清陈旧快照；有差异则写入 emergencyDrafts 并 scheduleBlockText 再落盘。
2. 权威 blocks **不**回灌抢救文本（避免差量基准把抢救态当成已落盘）；导出 overlayEmergencyDraftTexts 供展示叠字。
3. NotePaperStrictPanel：hydrateReady = status === 'ready' || status === 'empty'；displayBlocks = overlayEmergencyDraftTexts(blocks, emergencyDrafts) 传 Header/Body/ChromeSlot。
4. flush 排空成功清 storage 时同步 setEmergencyDrafts(null)。

## 改动文件
- apps/crish-desktop/src/components/note-paper/useNoteTextPersistence.ts
- apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx
- apps/crish-desktop/src/components/note-paper/useNoteTextPersistence.test.ts（§6 行为测）
- NEW apps/crish-desktop/src/components/note-paper/useNoteTextPersistence.sec6.source.test.ts（生产接线源码契约）

## 测试结果（本机）
- vitest useNoteTextPersistence.test.ts + useNoteTextPersistence.sec6.source.test.ts：**11 passed**
  - 含：挂载读回 + 叠字 + 再落盘；hydrateReady=false 不读回；已一致清陈旧；overlay 纯函数；源码契约锁 loadEmergencyDraftSync(docId) 生产调用与 Panel displayBlocks
- 回归 NotePaperStrictPanel.test.tsx：**16 passed**

## QUALITY-GATE 自检
1. 意图可陈述 — §6.1 写必可读回 / 只写不读伪连通
2. 无新旁路 — 复用已有 load/save/clear API，无第二套 storage
3. 对称失败 — loading 不读回；权威 blocks 与展示分离；陈旧快照可清除
4. 测试非假绿 — 行为断言 + 源码契约（禁止「仅单测 import load」冒充生产接线）
5. 门禁可执行 — 本项以 vitest 源码契约锁定；§9.7 全量扫描挂总闸**未做**（属 §9，本路不开）
6. 二次核查 — 待 code-audit

## 未完成 / 交接（明确不做）
1. §6.2 flushPendingDraft 形式化排空 — **已由续节完成**（见下文）
2. §6.3 块 ID crypto 熵 — **已由续节完成**（见下文）
3. §9.7 check:desktop 应急草稿引用扫描挂总闸 — **未做**
4. **不开 §7**

## 非假装修完（本项）
生产挂载路径会 loadEmergencyDraftSync；与 beforeunload 写入对称；UI 经 displayBlocks 可读回；有测防假绿。

---

# FIX-PROGRESS-§6（续 · 本路 flush 排空 + 块 ID 熵）

> date 2026-09-08 (America/New_York)
> scope SYSTEMATIC-FIX-PLAN §6 第 2–3 项 + QUALITY-GATE
> 本路只做：flushPendingDraft 排空形式化；桌面生产块 ID 强制 crypto 熵。不开其它节；§6.1 由并行路已完成（见上文）。

## 意图
1. 消灭 flushPendingDraft「固定两轮 pass」伪排空：循环至 pending/queue/inFlight 皆空，或停滞/触顶时显式 throw（失败可见）。
2. newNoteBlockId：生产构建强制 crypto（randomUUID / getRandomValues）；弱熵仅 DEV/test helper，不得出现在生产可达路径。

## §6.2 flushPendingDraft 排空语义
1. 删除 for (let pass = 0; pass < 2; pass++)。
2. 以 MAX_DRAIN_ROUNDS = 64 为安全上界循环：候选空则 return；await 全量 flush；仍空 return；队列/飞行推进或 pending 规模下降则 continue；无进展则 unsaved + throw drain stalled；触顶 throw exceeded。
3. 源码契约：useNoteTextPersistence.sec6.flush.source.test.ts（与 §6.1 读回契约分文件）。

## §6.3 块 ID 生产熵
1. noteBlockId.ts：优先 crypto.randomUUID，否则 getRandomValues 组装 UUID v4。
2. 皆失败时：PROD 硬抛错；仅 DEV 或 MODE=test 调用 fillWeakEntropyForDevOnly；其它模式拒绝弱熵。
3. newNoteBlockId 函数体内无 Math.random；弱熵隔离在 DEV-only helper。

## 改动文件（本路）
- useNoteTextPersistence.ts（flush 排空）
- noteBlockId.ts
- NEW useNoteTextPersistence.sec6.flush.source.test.ts
- NEW noteBlockId.sec6.source.test.ts
- noteBlockId.test.ts（注释）
- NEW scripts/check-sec6-note-drain-entropy.mjs

## 测试结果（本机）
- vitest flush + noteBlockId + useNoteTextPersistence.test：17 passed（4 files）
- node scripts/check-sec6-note-drain-entropy.mjs：SEC6 PASS
- 总闸：check:sec6-note-drain-entropy 已挂根 package.json 与 check:desktop；直跑再确认 SEC6 PASS（2026-09-08 ET）

## QUALITY-GATE 自检（本路）
1. 意图可陈述 — §6.2 / §6.3
2. 无新旁路 — 无第二套 flush；无生产弱熵轨
3. 对称失败 — 排空停滞/触顶 throw；生产缺熵 throw
4. 测试非假绿 — 源码契约禁 pass<2；禁 fn 体内 Math.random
5. 门禁可执行 — 脚本已落地可独立跑绿；总闸接线标「未接线=未完成」（需父代理把 check-sec6-note-drain-entropy 挂入桌面总闸）
6. 二次核查 — 待 code-audit

## 未完成 / 交接
1. 把门禁脚本挂入桌面总闸（scripts/check-sec6-note-drain-entropy.mjs）
2. code-audit 出 FIX-§6-verification.md
3. 不开 §7

## 非假装修完（本路两项）
flush 循环至空或显式失败；生产块 ID 强制 crypto 熵，弱熵不在生产可达路径。

