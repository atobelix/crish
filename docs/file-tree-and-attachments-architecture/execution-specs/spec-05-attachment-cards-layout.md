# 施工任务书 05：消息气泡附件 58×58 卡片与独立横排布局重塑

> **文档标识**：`docs/file-tree-and-attachments-architecture/execution-specs/spec-05-attachment-cards-layout.md`
> **所属战役**：`docs/file-tree-and-attachments-architecture/`
> **指派角色**：`Message Attachment & Layout Refactor Engineer`
> **纪律铁律**：
> 1. **严格遵照用户参考图（media_1788837641997.png）布局：上方独立 58×58 横向卡片流 + 下方独立文本气泡！**
> 2. 彻底物理删除原 61 行死亡 CSS 与旧 JSX，严禁留存任何旧药丸胶囊类名；
> 3. 严格独占文件域，严禁执行 git commit。

---

## 一、独占文件白名单（Forbidden to touch any other file）

1. `apps/crish-desktop/src/components/chat-attachment/AttachmentCard.tsx`（新建）
2. `apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css`（新建）
3. `apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx`（核心重构）
4. `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`（核心重构）
5. `apps/crish-desktop/src/components/chat-message-row/__tests__/ChatUserMessageRow.test.tsx`（单测验证）

---

## 二、新建 58×58 原子卡片 `AttachmentCard`

### 1. `AttachmentCard.tsx`
- 路径：`apps/crish-desktop/src/components/chat-attachment/AttachmentCard.tsx`
- **Props 规范**：
  ```typescript
  import React from 'react';
  import { Tooltip } from '../ui';
  import { FileFormatIcon } from '../../assets/icons';
  import type { ChatAttachment } from '../../hooks/useChatStream';
  import { convertFileSrc, isAbsoluteFsPath } from '../../api/workspaceFsApi';
  import styles from './AttachmentCard.module.css';

  export interface AttachmentCardProps {
    attachment: ChatAttachment;
    onClick?: () => void;
  }
  ```
- **呈现逻辑**：
  - 判断是否为图片：`Boolean(attachment.dataUrl || (attachment.mime && attachment.mime.startsWith('image/')) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.name))`；
  - **图片模式**：
    - 渲染 `<img src={imgSrc} alt={attachment.name} className={styles.cardImage} />`；
    - CSS 保证 58×58 内部填充满幅，`object-fit: cover`，外层 `overflow: hidden; border-radius: 12px`；
  - **非图片模式**：
    - 顶部行：左侧 18px `FileFormatIcon`，右侧大写徽标（`CODE` / `TABLE` / `TEXT` / `FILE`）；
    - 底部行：11px 文件名，省略号截断（`text-overflow: ellipsis; white-space: nowrap; overflow: hidden;`）；
  - **外层容器**：
    - 严格包裹 `<Tooltip content={attachment.path || attachment.name}>`；
    - 点击事件阻止冒泡：`e.stopPropagation()`，触发 `onClick?.()`。

### 2. `AttachmentCard.module.css`
- 严格基于 Design Tokens：
  ```css
  .attachmentCard {
    width: 58px;
    height: 58px;
    min-width: 58px;
    min-height: 58px;
    max-width: 58px;
    max-height: 58px;
    box-sizing: border-box;
    border-radius: var(--radius-xl, 12px);
    border: 1px solid var(--composer-attach-remove-border, var(--border-subtle));
    background: var(--composer-attach-card-bg, var(--bg-card));
    cursor: pointer;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 6px;
    position: relative;
    box-shadow: none;
    transition: border-color var(--transition-fast, 120ms) ease,
                background-color var(--transition-fast, 120ms) ease;
    user-select: none;
  }

  .attachmentCard:hover {
    border-color: var(--border-color);
    background-color: color-mix(in srgb, var(--text-primary) 2.5%, var(--bg-card));
  }

  .cardImageWrapper {
    width: 58px;
    height: 58px;
    padding: 0;
  }

  .cardImage {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: inherit;
  }

  .cardTopRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }

  .cardKindBadge {
    font-size: 8px;
    font-weight: 700;
    color: var(--text-tertiary);
    line-height: 1;
    text-transform: uppercase;
  }

  .cardName {
    font-size: 11px;
    color: var(--text-primary);
    line-height: 1.2;
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ```

---

## 三、`ChatUserMessageRow.tsx` 物理删除与新布局重塑

### 1. 物理删除清单（原行号）
1. **删除原行 86-91** 的人工拆分逻辑：
   - 彻底删除 `const images = ...; const nonImageAttachments = ...; const hasImages = ...; const hasAttachments = ...;`；
   - 统一归一化为 `const attachments = useMemo(...)`；
2. **彻底删除原行 191-226** 的 `hasImages` 裸图堆叠画廊 JSX（36 行）；
3. **彻底删除原行 228-252** 的 `hasAttachments` 灰色胶囊 JSX（25 行）。

### 2. 严格按用户参考图（media_1788837641997.png）重塑 JSX 布局
在 `styles.userStack` 内部：
```tsx
<div className={styles.userStack}>
  {isPinned ? (
    <Tooltip content="已固定">
      <span className={styles.pinBadge} aria-hidden="true">
        <Pin size={11} strokeWidth={2.25} />
        已固定
      </span>
    </Tooltip>
  ) : null}

  {/* 1. 上方：独立的 58x58 卡片横排流（AttachmentStrip） */}
  {attachments.length > 0 ? (
    <div className={styles.userAttachmentStrip} data-testid="user-attachments-strip">
      {attachments.map((att) => (
        <AttachmentCard
          key={att.id || att.path || att.name}
          attachment={att}
          onClick={() => {
            if (att.path && att.path.trim()) {
              handleOpenPath(att.path.trim());
            } else {
              showToast('该附件无关联本地物理路径');
            }
          }}
        />
      ))}
    </div>
  ) : null}

  {/* 2. 下方：独立的文本对话气泡（仅在有文本时渲染） */}
  {displayText ? (
    <div
      className={styles.userBubble}
      onClick={toggleExpand}
      onKeyDown={onBubbleKeyDown}
      style={{ cursor: isLong ? 'pointer' : 'default' }}
      role={isLong ? 'button' : undefined}
      tabIndex={isLong ? 0 : undefined}
      aria-expanded={isLong ? isExpanded : undefined}
      aria-label={isLong ? userBubbleExpandAria(isExpanded) : undefined}
    >
      {displayText}
      {msg.status === 'queued' && (
        <span className={styles.queued}>排队中</span>
      )}
    </div>
  ) : null}

  <UserMessageActionsBar ... />
</div>
```

---

## 四、`ChatMessageRow.module.css` 物理切除 61 行死亡样式

1. **物理删除原行 116-176**：
   - 彻底删除 `.userImages`, `.userImageWrapper`, `.userImage`, `.userAttachments`, `.userAttachmentChip`, `.userAttachmentChip:hover`, `.userAttachmentName`；
2. **新增 `.userAttachmentStrip` 样式**：
   ```css
   .userAttachmentStrip {
     display: flex;
     flex-direction: row;
     flex-wrap: wrap;
     justify-content: flex-end;
     align-items: center;
     gap: var(--space-2, 8px);
     width: 100%;
     max-width: min(70.2%, 560px);
     box-sizing: border-box;
   }
   ```

---

## 五、验收命令

在 `ChatUserMessageRow.test.tsx` 中增加**负向断言**（确保 `.userAttachmentChip` 彻底不存在），并验证 `userAttachmentStrip` 与 `AttachmentCard` 的渲染。

验收执行命令：
```powershell
npx vitest run src/components/chat-message-row/
```
