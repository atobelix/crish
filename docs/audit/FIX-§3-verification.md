# §3 修复抽查 · FIX-§3-verification

> 核查人：code-audit · 2026-09-08（America/New_York）  
> 标准：`QUALITY-GATE.md` 可证伪  
> 对照：`FIX-PROGRESS-§3.md` · 前置 §1 已闭合

## 总裁定：**§3 有条件通过（无阻断 `[!]`）**

| 小节 | 标记 | 说明 |
|------|:----:|------|
| §3.1 单管道 + F2 打开硬拒绝 | `[x]` | 见 R3-1 |
| §3.2 json 真解析 / 计行 / reveal | `[x]` | |
| §3.3 非视觉脱敏 + 落盘脱敏 + 批注不可变 | `[x]` | 见 R3-2 |
| 门禁可执行 | `[x]`/`[~]` | 独立脚本 + 嵌入 PASS；package.json 正式挂名 MISSING |

可进入 §4；正式挂名 `check:no-nonvision-dataurl` 记为收尾项（同 §1 F4 曾有的形态，进度已标明「未单独挂名≠未覆盖」）。

---

## §3.1 `[x]`

**证据**

- `api/attachmentIntake.ts`：stable key、500ms `claim` 去重、`extractFileSystemPath`、`mergeAttachmentsIdempotent`。
- `useChatAttachments`：`handlePathsSelected` 先 `claim` 再 `assertWorkspacePath`；`handleDroppedFiles` 分流 path→paths / blob→files。
- `ChatCard`：`tauri://drag-drop`→`handlePathsSelected`；window/DOM/`onFilesSelected`→`handleDroppedFiles`（单一消费在 hook）。
- F2：`ChatUserMessageRow.handleOpenPath` 拒 data/http；绝对路径 `assertWorkspacePath`，失败 toast。

**R3-1 `[~]`**：`handleFilesSelected` 对带 `File.path` 的项 `continue`（静默丢弃）而非转发 `handlePathsSelected`。主 UI 经 `handleDroppedFiles` 无此问题；若直调 `handleFilesSelected` 会丢文件。建议改为 `await handlePathsSelected([fsPath])`。

---

## §3.2 `[x]`

**证据**

- `jsonFormatUtils.ts`：`stripJsoncComments` 真剥离；`formatJsonl` 逐行 `JSON.parse`，坏行 `success: false` + 行号；`formatJsonSafe(filePath)` 选轨。
- `countTextLines.ts`：按 `\\n` 计行、含末空行；`readTextFile` 回退计行用 `countTextLines`，无 `split('\\n')` 分配回潮。
- `revealInOs`：先 `assertWorkspacePath`。

---

## §3.3 `[x]`

**证据**

- `multimodal.ts`：非视觉 `redactNonVisionImageNote` 仅名/MIME/大小；通用文件只 `- ${a.name}`；无 `源数据:` / `pathInfo`。
- `attachmentPersistSanitize.ts` + `useSlashSend`：入库相对引用 / content hint + thumbnail；不写完整 dataUrl 字段。
- `updatePendingFileAnnotationComment`：`map` + 新对象替换，不可变。

**活跑门禁**

- `node scripts/check-no-nonvision-dataurl.mjs` → `PASS`
- `node scripts/check-no-pseudo-dispatch.mjs` → `PASS`（含 §3.3 嵌入扫描）
- package.json：`check:no-nonvision-dataurl` = **MISSING**；未进 `check:desktop` 具名项 → `[~]`

**R3-2 `[~]`**：`sanitizeImageRefForPersist` 仍把 `thumbnailUrl`（多为小 dataUrl）写入 `resolvedUrl`。相对「完整原图 dataUrl」已收敛，但落盘仍可能含 dataUrl 片段；可接受为展示折中，建议后续外置 blob/相对资源。

---

## QUALITY-GATE 对照

1. 意图可陈述 — 过（§3.1–3.3 + F2）  
2. 无新旁路 — 过（拖放/读盘走 assert；非视觉无 dataUrl 拼 prompt）  
3. 对称失败 — 过（越界 skip；打开 toast；jsonl 坏行失败）  
4. 测试非假绿 — 进度称 108 passed；门禁静态扫描有行为特征断言（非仅「不抛错」）  
5. 门禁可执行 — 过（嵌入+独立）；正式挂名 `[~]`  
6. 二次核查 — 本文件；**无阻断 `[!]`**

---

## 结论与交接

- **§3 通过，可进 §4。**  
- 收尾（不挡节间放行）：  
  1. package.json 正式挂 `check:no-nonvision-dataurl` 进 `check:desktop`，去掉伪嵌入（若仍嵌在 pseudo-dispatch）  
  2. R3-1：`handleFilesSelected` 对 `File.path` 转发而非 continue  
  3. R3-2：缩略图落盘策略再收敛（可选）

_文档由 code-audit 可证伪抽查生成_
