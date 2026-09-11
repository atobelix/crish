# §2 修复抽查 · FIX-§2-verification

> 核查人：code-audit · 2026-09-08（America/New_York）
> 标准：`QUALITY-GATE.md` 可证伪
> 范围：`FIX-PROGRESS-§2.md`（方案 §2.1；§2.2 进度自报未做）
> 前置：§1 仍有阻断项（见 FIX-§1-verification）——本文件只评 §2.1 改动本身

## 总裁定：**§2.1 有条件通过**（无 `[!]` 阻断项）；**§2 整节未闭合**（§2.2 未做 + 依赖 §1 未过闸）

| 项 | 标记 | 说明 |
|----|:----:|------|
| 意图可陈述（§2.1 拆 stub） | `[x]` | 与计划一致 |
| 物理删除 slashContextCards.ts | `[x]` | Test-Path = False |
| workflowAssistantCard 无 dispatch* | `[x]` | 仅 TEMPLATE + buildWorkflowAssistantContext |
| 调用方改 safe_seed / wire / toast | `[x]` | slashSendPreflight / Schedule 面板与 Tab |
| 空 stub 仍被调用 | `[x]` 无此问题 | rg 无生产 dispatch* 符号 |
| 门禁 check-no-pseudo-dispatch | `[x]` | 本机执行 PASS |
| 门禁挂总闸 | `[~]` | 经 input-guard 嵌入；package.json 未挂名 |
| 失败可观测 | `[~]` | SettingsScheduleTab 无会话有 toast；ScheduledTasksPanel 无会话仅 warn+return，无 toast |
| §2.2 文档伪连通 | `[!]` 未做 | 进度自报；整节 §2 不能称完成 |
| 测试非假绿 | `[x]`/`[~]` | gate 测 spawn 真脚本；坏样本用拼接符号避开自扫描——可接受 |

---

## 证据

### 拆除与真路径 `[x]`

- `slashContextCards.ts` 已删除。
- `workflowAssistantCard.ts` 注释明确禁止空壳 dispatch。
- `slashSendPreflight.ts`：`WORKFLOW_CREATE_TEMPLATE` + `mode: 'safe_seed'`；带参 `buildWorkflowAssistantContext` wire。
- `ScheduledTasksPanel.handleCreateInChat`：`injectSeed` + toast 成功文案。
- `SettingsScheduleTab.handleAiCreateSchedule`：有会话 injectSeed+toast；无会话 toast 失败。

### 门禁 `[x]` / `[~]`

- `scripts/check-no-pseudo-dispatch.mjs`：禁符号 + 空 stub 正则 + chat-injection 路径；本机 `PASS pseudo-dispatch / chat-injection gate`。
- `check-markdown-style-compliance.mjs`：本机 PASS（§1.4 相关，嵌入同跑）。
- `check-input-guardrails.mjs` `SEC14_SEC2_EMBEDDED_GATES` 串联二者。
- package.json：`check:markdown-style` / `check:no-pseudo-dispatch` = MISSING（与进度一致）。

### 残留 / 非阻断

1. **R2-1** `ScheduledTasksPanel` 无 `activeSid` 时无失败 toast（与 Tab 不对称）——建议补齐可观测失败。
2. **R2-2** `SettingsScheduleTab` 注释仍写「可见助手卡片」——文案腐化，建议改。
3. **R2-3** §2.2 未做 → 整节完成态不得宣称。

---

## QUALITY-GATE 对照（§2.1）

1. 意图可陈述 — 过
2. 无新旁路 / 无 stub 恒成功 — 过
3. 对称失败 — 基本过，R2-1 轻微不对称
4. 测试非假绿 — 过（真跑门禁脚本）
5. 门禁可执行 — 过（嵌入）；正式挂名未完成 `[~]`
6. 二次核查 — 本文件；**无 §2.1 `[!]`**

---

## 结论与交接

- **§2.1 代码抽查：通过（无阻断 `[!]`）**。
- **不得解释为「§1+§2 已过闸」**：§1 F1–F3 仍阻断；§2.2 未做。
- 建议 main：先消化 §1 复检清单，再补 §2.2 / package.json 正式接线；ScheduledTasksPanel 无会话失败 toast 可顺手修。

_文档由 code-audit 可证伪抽查生成_
