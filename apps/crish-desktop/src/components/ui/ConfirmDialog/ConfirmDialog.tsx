/**
 * ui/ConfirmDialog 确认对话框基座（02-E3 改语义 · C-7 裁决 · 03-detail T15，批次 4.0）
 *
 * 契约（04-detail §2.1.1，实现与验收基线）：
 * - 基于 ui/Dialog 封装确认语义：role="alertdialog" + title→aria-labelledby
 *   + description→aria-describedby；
 * - 初始焦点落取消钮（danger 变体确认钮
 *   不默认聚焦——本组件始终以取消钮为初始焦点）；
 * - Esc = 取消 + 归还原焦点（继承 Dialog 三件套：FocusTrap/useRestoreFocus/
 *   dialogStack）；Enter = 浏览器原生激活当前聚焦钮，**不劫持为确认**
 *   （初始焦点在取消钮 → Enter 即取消，防危险误触）；
 * - 无关闭按钮（showCloseButton=false）；遮罩点击 = 取消（dismissible）；
 * - 受控组件：不管理 open 状态（无内部状态机），onConfirm/onCancel 由调用方
 *   或 hooks/useConfirmGate Promise 桥提供。
 *
 * 文案模板（04-detail §2.1.5）：
 * 标题 = 动词短语（「放弃修改」「删除对话」「清空用量」「强制取消」…）；
 * description = 原 confirm 全文（保留「不可逆/永久丢失」等后果说明）；
 * 按钮 = [取消][确认]，危险项确认钮 danger 变体 + 「确认删除/确认放弃/…」。
 *
 * 扩展点纪律：多按钮（三选一确认）→ 业务组合层（footer 插槽消化），不扩 props；
 * 新形态先扩联合类型再全量对齐（同 ui/Button 纪律，穷举而非开放字符串）。
 *
 * 分层契约：只依赖 react + ui/Dialog + ui/Button + tokens CSS 变量。
 */
import React from 'react';
import { Dialog } from '../Dialog/Dialog';
import type { DialogSize } from '../Dialog/Dialog';
import { Button } from '../Button/Button';

/**
 * 方案 A 标尺与纪律（同心几何收敛）：
 * 底部确认与取消按钮高度统一为 34px~36px，按钮圆角统一设为 var(--radius-md, 8px)，
 * 消除 7px 杂音值（与外壳 24px + 边距 16px 形成 24 = 8 + 16 绝对同心）。
 */
const confirmButtonStyle: React.CSSProperties = {
  minHeight: '36px',
  height: '36px',
  borderRadius: 'var(--radius-md, 8px)',
};

export interface ConfirmDialogProps {
  /**
   * 受控开合（基座不管理 open 状态，不设内部状态机）。
   * 直接受控使用时必传；经 hooks/useConfirmGate Promise 桥使用时由桥注入。
   */
  open?: boolean;
  /** 标题（→ aria-labelledby；动词短语文案模板） */
  title?: React.ReactNode;
  /** 正文（→ aria-describedby；原 confirm 全文入此，含「不可逆/永久丢失」后果说明） */
  description?: React.ReactNode;
  /** 确认钮文案（危险项「确认删除/确认放弃/确认清空/确认强制取消」…） */
  confirmLabel?: React.ReactNode;
  /** 取消钮文案 */
  cancelLabel?: React.ReactNode;
  /** 危险变体：确认钮 variant="danger"，且不默认聚焦（初始焦点仍落取消钮） */
  danger?: boolean;
  /** 确认回调。直接受控使用时必传；经 useConfirmGate 桥使用时由桥注入。 */
  onConfirm?: () => void;
  /** 取消回调（Esc / 取消钮 / 遮罩统一归口）。直接受控使用时必传；经桥使用由桥注入。 */
  onCancel?: () => void;
  /** 确认钮 disabled（异步进行中防重复提交，对齐 BgTaskActions busyAny 语义） */
  disabled?: boolean;
  /** 尺寸档透传 ui/Dialog */
  size?: DialogSize;
  /** 自定义类名（透传 Dialog 面板） */
  className?: string;
  /** 自定义类名（透传 Dialog 遮罩壳） */
  overlayClassName?: string;
  /** Portal 挂载目标（透传 Dialog；默认 document.body） */
  portalTarget?: HTMLElement | null;
}

export function ConfirmDialog({
  open = false,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
  disabled = false,
  size = 'md',
  className,
  overlayClassName,
  portalTarget,
}: ConfirmDialogProps) {
  // 初始焦点显式落取消钮：不依赖「取消钮恰为首个可交互元素」的 DOM 顺序假设，
  // 取消钮在前、确认钮在后；danger 变体确认钮亦不默认聚焦（契约）。
  const cancelButtonRef = React.useRef<HTMLButtonElement>(null);

  // onConfirm/onCancel 可为空（经 useConfirmGate 桥注入时必非空；直接受控必传）
  const confirm = onConfirm ?? (() => {});
  const cancel = onCancel ?? (() => {});

  return (
    <Dialog
      open={open}
      onClose={cancel}
      role="alertdialog"
      title={title}
      description={description}
      size={size}
      showCloseButton={false}
      initialFocusRef={cancelButtonRef}
      classNames={
        className || overlayClassName
          ? { panel: className, overlay: overlayClassName }
          : undefined
      }
      portalTarget={portalTarget}
      footer={
        // Dialog 的 .dialogFooter 已提供 flex + gap 布局，直接挂载按钮 Fragment
        <>
          <Button
            ref={cancelButtonRef}
            type="button"
            variant="secondary"
            onClick={cancel}
            style={confirmButtonStyle}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={danger ? 'danger' : 'primary'}
            disabled={disabled}
            onClick={confirm}
            style={confirmButtonStyle}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
