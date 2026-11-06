/**
 * Layer 3: 上下文与文件引用卡片区（Attachment Bar）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4.4 与 reference/chat-composer-component/css/file-cards.css
 * - 24px 高度圆角芯片卡片（.file-card / .attachChip）；
 * - 官方 160+ 高频彩色格式图标（FileFormatIcon）；
 * - 文件名省略号截断；
 * - 右上角微型删除叉号（.file-remove，无阴影扁平圆钮，Hover 变红）；
 * - 图片缩略图预览（24px）；
 * - 点击文件名/卡片在右侧打开该文件（openFileInPanel / onOpenPath）。
 */
import React, { useEffect, useRef, useState } from 'react';
import styles from './ComposerAttachmentBar.module.css';
import type { ChatAttachment } from '../../hooks/chat-stream';
import { openFileInPanel } from '../../api/filePanelOpener';
import {
  AttachmentCard,
  isImageAttachmentItem,
} from '../chat-attachment/AttachmentCard';
import { useExitReveal } from '../motion/useExitReveal';
import {
  DURATION_EXIT_MS,
  EXIT_SETTLE_BUFFER_MS,
} from '../../utils/motionTokens';

export interface ComposerAttachmentBarProps {
  attachments: ChatAttachment[];
  onRemoveAttachment: (name: string) => void;
  /** 点卡开预览；缺省走 openFileInPanel（工作区叶） */
  onOpenPath?: (path: string) => void;
}

export type AttachKind =
  'image' | 'code' | 'table' | 'text' | 'file' | 'annotation';

export function attachKind(a: ChatAttachment): AttachKind {
  if (a.annotation || a.mime === 'text/x-annotation') {
    return 'annotation';
  }
  if (
    a.isImage ||
    a.dataUrl ||
    (a.mime && a.mime.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(a.name || a.path || '')
  ) {
    return 'image';
  }
  if (/\.(csv|tsv|xlsx?)$/i.test(a.name || a.path || '')) {
    return 'table';
  }
  if (
    /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|json)$/i.test(
      a.name || a.path || ''
    )
  ) {
    return 'code';
  }
  if (
    a.text ||
    /\.(md|markdown|txt|log|ya?ml|toml)$/i.test(a.name || a.path || '')
  ) {
    return 'text';
  }
  return 'file';
}

import { useI18n } from '../../i18n';
import { AnnotationChipItem } from './AnnotationChipItem';

/**
 * S4 退场：附件卡片的横向退场包裹。AttachmentCard 被 Tooltip 直接克隆
 * （无包裹层），卡根本身即条带的 flex 子项，本可直接收卡宽；但卡有
 * 三处返回分支（图片/失效/文件），在共享组件上三处同改不如由条带侧
 * 一处包裹收敛。包裹层是 flex 子项：宽度收敛 + 负 margin 抵消一份
 * 8px gap，卸载时零跳变。卡片在包裹内重挂一次；AttachmentCard 无挂载
 * 动画（仅 transition），重挂无回放。批注 chip 有 composerAttachArrive
 * 入场动画，故不用包裹、直接在 chip 根上退场（见 AnnotationChipItem）。
 */
function ClosingAttachWrap({ children }: { children: React.ReactNode }) {
  const exit = useExitReveal({ closing: true, axis: 'horizontal', gapPx: 8 });
  return (
    <span
      ref={exit.rootRef}
      className="crish-exit-fade"
      data-exiting="true"
      aria-hidden
    >
      {children}
    </span>
  );
}

function attachmentKey(a: ChatAttachment, index: number): string {
  return (
    a.id ||
    (a.annotation ? a.annotation.id : `${a.path || a.name}_${index}`)
  );
}

/** S4 退场快照：被移除的附件 + 移除时的条带位置（供原位收敛排序）。 */
type ClosingAttachEntry = { attachment: ChatAttachment; index: number };

export const ComposerAttachmentBar: React.FC<ComposerAttachmentBarProps> = ({
  attachments,
  onRemoveAttachment,
  onOpenPath,
}) => {
  const { t } = useI18n();
  const [activePopoverId, setActivePopoverId] = useState<string | null>(null);

  // S4 退场：正在退场的附件快照（键 → {附件, 移除时位置}），退场播完
  // （150ms + 余量）后清除。快照期条带保持挂载，最后 chip 的退场
  // 覆盖 H-04 整条塌陷；条带清空后的卡片高度回落由 S9 的
  // useComposerCardHeightGlide 覆盖（它监听附件条尺寸）。
  const [closingEntries, setClosingEntries] = useState<
    Map<string, ClosingAttachEntry>
  >(new Map());
  const closingTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  useEffect(() => {
    const timers = closingTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // S4：拦截移除——先快照（原位播退场），再立即调父级移除（数据层
  // 不等退场）；已在退场中的项不再重复移除。removeId 与原先逐处
  // 传入的值一致（卡片 a.id || a.name；批注 chip a.name）。
  const handleRemove = (
    a: ChatAttachment,
    index: number,
    removeId: string
  ) => {
    const key = attachmentKey(a, index);
    if (closingEntries.has(key)) return;
    setClosingEntries((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { attachment: a, index });
      return next;
    });
    setActivePopoverId((prev) => (prev === key ? null : prev));
    onRemoveAttachment(removeId);
    const timers = closingTimersRef.current;
    if (timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        setClosingEntries((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }, DURATION_EXIT_MS + EXIT_SETTLE_BUFFER_MS)
    );
  };

  if (attachments.length === 0 && closingEntries.size === 0) return null;

  const openPreview = (a: ChatAttachment) => {
    if (a.path && a.path !== a.name) {
      const open = onOpenPath ?? openFileInPanel;
      open(a.path.trim());
      return;
    }
    if (a.dataUrl) {
      const win =
        typeof window !== 'undefined' ? window.open('', '_blank') : null;
      if (win) {
        win.document.write(
          `<!DOCTYPE html><html><head><title>${a.name}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#111;}img{max-width:95vw;max-height:95vh;object-fit:contain;}</style></head><body><img src="${a.dataUrl}" alt="${a.name}"/></body></html>`
        );
        win.document.close();
      }
      return;
    }
    const targetPath = (a.path || a.name || '').trim();
    const open = onOpenPath ?? openFileInPanel;
    open(targetPath);
  };

  const attachAriaLabel = t('chat.composer.attachmentCountAria', {
    count: attachments.length,
  });

  // S4：实况槽 + 退场槽按移除时位置合并排序（同位退场项排在实况项前），
  // 被移除的 chip/card 在原位收敛，邻项随宽度动画平滑左移。退场槽的
  // React 键与移除时键相同（不加前缀）：批注 chip 必须保 identity，
  // 换键会重挂 chip、composerAttachArrive 入场重播与退场冲突；卡片
  // 在包裹内重挂无回放，键相同亦无害。
  const slots = [
    ...attachments.map((a, index) => ({
      key: attachmentKey(a, index),
      attachment: a,
      index,
      closing: false,
    })),
    ...[...closingEntries.entries()].map(([key, entry]) => ({
      key,
      attachment: entry.attachment,
      index: entry.index,
      closing: true,
    })),
  ].sort(
    (x, y) =>
      x.index - y.index || (x.closing === y.closing ? 0 : x.closing ? -1 : 1)
  );

  return (
    <div
      className={`${styles.fileZone} ${styles.attachStrip} file-zone`}
      role="list"
      aria-label={attachAriaLabel}
      data-testid="composer-attach-strip"
      data-composer-attachments=""
    >
      {slots.map((slot) => {
        const a = slot.attachment;
        const index = slot.index;
        const kind = attachKind(a);
        const itemKey = slot.key;
        if (kind === 'annotation' && a.annotation) {
          return (
            <AnnotationChipItem
              key={itemKey}
              attachment={a}
              closing={slot.closing}
              isOpen={slot.closing ? false : activePopoverId === itemKey}
              onRequestOpen={() => setActivePopoverId(itemKey)}
              onRequestClose={() =>
                setActivePopoverId((prev) => (prev === itemKey ? null : prev))
              }
              onRemove={() => handleRemove(a, index, a.name)}
              onOpenPath={onOpenPath}
            />
          );
        }

        const isImg =
          kind === 'image' ||
          isImageAttachmentItem({
            name: a.name,
            path: a.path,
            mime: a.mime,
            dataUrl: a.dataUrl,
            isImage: a.isImage,
          });

        const removeId = a.id || a.name;

        const card = (
          <AttachmentCard
            key={itemKey}
            item={{
              id: a.id,
              name: a.name,
              path: a.path,
              mime: a.mime,
              size: (a as { size?: number }).size,
              dataUrl: a.dataUrl,
              thumbnailUrl: a.thumbnailUrl,
              isImage: isImg,
              status: a.status,
              progress: a.progress,
            }}
            kind={kind}
            testId="composer-attach-card"
            onClick={() => openPreview(a)}
            onRemove={
              slot.closing ? undefined : () => handleRemove(a, index, removeId)
            }
            onAuxClick={
              slot.closing
                ? undefined
                : (e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      e.stopPropagation();
                      handleRemove(a, index, removeId);
                    }
                  }
            }
          />
        );
        return slot.closing ? (
          <ClosingAttachWrap key={itemKey}>{card}</ClosingAttachWrap>
        ) : (
          card
        );
      })}
    </div>
  );
};
