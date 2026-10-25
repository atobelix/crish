# 分维详案 01：ChatCard 与输入框纯化重构详案

> **文档位置**：`docs/pluggable-import-architecture/01-ChatCard与输入框纯化重构详案.md`  
> **所属战役**：可插拔导入插件架构重构与主视口解耦  
> **设计原则**：单一职责、零侵入、彻底纯化、绝不妥协打补丁

---

## 1. 目标与范围

彻底清除 `apps/crish-desktop/src/components/chat-card` 与 `apps/crish-desktop/src/components/chat-composer` 中针对外部导入会话的一切私货与特例逻辑，使两大核心 UI 组件恢复为纯粹的会话流呈现容器与全功能输入控制器。

---

## 2. 精确改动明细

### 2.1 ChatComposer.tsx 纯化
1. **契约清理**：
   - 在 [`apps/crish-desktop/src/components/chat-composer/composerTypes.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/composerTypes.ts) 中：
     彻底删除 `ExternalSessionPreviewContract` 接口及 `ChatComposerProps.externalSessionPreview` 属性。
2. **输入域 DOM 还原**：
   - 在 [`apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:344-383`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx#L344-L383) 中：
     彻底删除 `externalSessionPreview` 三元分支。
     删除外层 `div.fieldSlot` 上的 `onClick` 劫持。
     始终无条件渲染 `<ComposerFieldSlot ... />`。
3. **发送控制区逻辑还原**：
   - 在 [`apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:446-464`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx#L446-L464) 中：
     删除 `externalSessionPreview ? true : ...` 的短路判断，删除发送按钮点击时的 `onImportAndContinue` 分支，恢复原生的会话消息发送通道。
4. **CSS 样式清理**：
   - 在 [`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css) 中：
     删除 `.externalSessionImportBtn` 与 `.externalSessionImportText` 样式声明。

### 2.2 ChatCard.tsx 纯化
1. **移除导入 Hook**：
   - 彻底删除 `import { useExternalLongSessionDetection } from './useExternalLongSessionDetection';`；
   - 删除组件内部解构代码：
     ```ts
     // 彻底删除此代码块：
     const { previewExternalSession, isImporting, handleImportAndContinue } =
       useExternalLongSessionDetection({
         emptyKind: state.emptyKind,
         activeSessionId: state.activeSessionId,
       });
     ```
2. **空态与布局真理源收敛**：
   - 将 `isLanding` 还原为原生的：
     `const isLanding = state.emptyKind === 'session-empty';`；
   - 在传递给 `ChatComposer` 与 `ChatComposerWrapper` 的属性中，彻底移除 `previewExternalSession` 相关的三元操作符，直接传递 `state.emptyKind`；
   - 移除 `ChatComposer` 上的 `disabled={isImporting}`、`placeholder` 覆盖及 `externalSessionPreview` 传递。
3. **主文档流视口纯化**：
   - 在 [`apps/crish-desktop/src/components/chat-card/ChatCard.tsx:435-466`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatCard.tsx#L435-L466) 中：
     彻底删除 `previewExternalSession ? (<ChatMessageList ... />) : ...` 分支；
     恢复原生的 `state.emptyKind != null ? (<ChatEmptyState ... />) : (<SlotOutlet ... fallback={<ChatMessageList ... />} />)` 逻辑。

### 2.3 物理删除文件清单
- `apps/crish-desktop/src/components/chat-card/useExternalLongSessionDetection.ts`（物理删除）
- `apps/crish-desktop/src/components/chat-card/__tests__/useExternalLongSessionDetection.test.ts`（物理删除）
- `apps/crish-desktop/src/components/chat-card/__tests__/ChatCard.previewExternalSession.test.tsx`（物理删除）

---

## 3. 验收断言

1. `npm run typecheck` 零类型报错。
2. `npx vitest run apps/crish-desktop/src/components/chat-composer/ChatComposer.test.tsx` 通过，且断言在空态时输入框聚焦可见、键盘可直接输入。
3. `npx vitest run apps/crish-desktop/src/components/chat-card/` 全量通过，空态单一真理源完全受 `state.emptyKind` 驱动。
