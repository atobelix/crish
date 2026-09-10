# FIX-PROGRESS-§3

> date 2026-09-08 (America/New_York)
> scope SYSTEMATIC-FIX-PLAN §3.1 / §3.2 / §3.3 + QUALITY-GATE
> 前置：§1 已闭合；顺手消化 F2 残留（点击打开盲传区外 source）

## 意图
把 §1 路径/读盘原语接到全部附件与文件入口：拖放单一管道、文件面板/预览/链接全经沙箱、多模态非视觉脱敏 + 落盘脱敏、批注不可变更新。禁止双轨/stub/假绿。

## §3.1 附件与拖放单一管道
1. 新增 `api/attachmentIntake.ts`：stable key、短窗去重（500ms）、`extractFileSystemPath`、`mergeAttachmentsIdempotent`。
2. `useChatAttachments`：
   - 入队改幂等合并；
   - `handlePathsSelected` 经 assertWorkspacePath + localFileReader，并短窗 claim；
   - 新增唯一拖放入口 `handleDroppedFiles`（有 File.path → paths 管；纯 blob → files 管）；
   - blob 路径不再旁路写绝对 path。
3. `ChatCard`：`tauri://drag-drop` → `handlePathsSelected`；window/卡片 DOM drop + `onFilesSelected` → `handleDroppedFiles`（与 Tauri 双事件幂等合流）。
4. F2 残留：`ChatUserMessageRow.handleOpenPath` 对 data/http 拒绝；绝对路径先 `assertWorkspacePath`，失败 toast，禁止盲传区外 source。

## §3.2 文件面板 / 预览 / 路径链接
1. `revealInOs` 改为先 `assertWorkspacePath`（与 read/write/toAssetUrl 对称）。
2. `jsonFormatUtils`：实现 jsonc 注释剥离真解析 + jsonl 逐行真解析；按钮可点且能成功；坏行硬失败。调用方传入 `filePath`。
3. `readTextFile` 计行去掉 `split('\n')`，改用 `countTextLines`（与 LineBuffer 行边界对齐）。

## §3.3 多模态上行与落盘
1. `multimodal.ts` 非视觉：仅文件名/MIME/大小元数据；禁止 dataUrl 与绝对路径进 prompt；通用文件同样不拼 path。
2. `attachmentPersistSanitize.ts` + `useSlashSend`：消息入库用相对引用/内容线索 + 缩略图，默认不存完整 dataUrl/绝对 path。
3. `fileAnnotations.updatePendingFileAnnotationComment`：不可变更新（新对象替换，禁止原地 mutate）。

## 门禁
- `scripts/check-no-nonvision-dataurl.mjs`（独立脚本）
- `package.json`：新增 `check:no-nonvision-dataurl`；**已挂入** `check:desktop`（紧接 `check:no-pseudo-dispatch` 之后）——F4 式挂名
- 已从 `scripts/check-no-pseudo-dispatch.mjs` 去掉 §3.3 嵌入扫描（消除双重扫描）

## 改动文件
- NEW `apps/crish-desktop/src/api/attachmentIntake.ts` (+test)
- NEW `apps/crish-desktop/src/api/attachmentPersistSanitize.ts` (+test)
- NEW `apps/crish-desktop/src/api/countTextLines.ts` (+test)
- NEW `scripts/check-no-nonvision-dataurl.mjs`
- `apps/crish-desktop/src/components/chat-card/useChatAttachments.ts`
- `apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts`
- `apps/crish-desktop/src/components/chat-card/ChatCard.tsx`
- `apps/crish-desktop/src/components/chat-card/ChatCard.stream-slot.test.tsx`
- `apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx`
- `apps/crish-desktop/src/hooks/chat-stream/multimodal.ts` (+test)
- `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts`
- `apps/crish-desktop/src/components/files/jsonFormatUtils.ts` (+test)
- `apps/crish-desktop/src/components/files/hooks/useFilePreview.ts`
- `apps/crish-desktop/src/components/files/FileViewerCard.tsx`
- `apps/crish-desktop/src/api/workspaceFsApi.ts`
- `apps/crish-desktop/src/api/fileAnnotations.ts` (+test)
- `apps/crish-desktop/src/api/localFileReader.test.ts`（修正源码扫描路径）
- `scripts/check-no-pseudo-dispatch.mjs`（已去掉 §3.3 嵌入扫描）

## 测试结果（本机）
- `node scripts/check-no-pseudo-dispatch.mjs` PASS（已无 §3.3 嵌入）
- `node scripts/check-no-nonvision-dataurl.mjs` PASS
- vitest 相关 **108 passed**（67 + 41）：
  - attachmentIntake / persistSanitize / countTextLines / fileAnnotations
  - multimodal / jsonFormatUtils / workspaceFsApi / localFileReader / ComposerDropHost
  - desktopNativeFeatures / FileViewerCard / FileAnnotationPopover

## QUALITY-GATE 自检
1. 意图可陈述 — §3.1–3.3 + F2
2. 无新旁路 — 拖放/读盘只走 assert + localFileReader；非视觉无 dataUrl 旁路
3. 对称失败 — 越界 path 入队跳过；打开路径 toast；jsonl 坏行 success:false
4. 测试非假绿 — 覆盖双入队去重、非视觉禁止 dataUrl/绝对路径、jsonc/jsonl 成败、不可变批注、计行对齐 LineBuffer
5. 门禁可执行 — F4 式挂名完成：独立脚本已在 package.json scripts 与 check:desktop（紧接 check:no-pseudo-dispatch 后）；嵌入双扫已去 `[x]`
6. 二次核查 — 待 code-audit

## 未完成 / 交接
1. ~~package.json F4 式挂名~~ 已完成（独立脚本 + check:desktop；去嵌入双扫）。
2. code-audit 出具 `FIX-§3-verification.md`。
3. Composer/Tiptap 层仍经 `onFilesSelected` 转发到 `handleDroppedFiles`（单一消费在 attachments hook；非第二实现）。

## 非假装修完
未保留 stub；jsonc/jsonl 为真解析；非视觉不再塞源 dataUrl；批注更新不可变；计行无 split 回潮。