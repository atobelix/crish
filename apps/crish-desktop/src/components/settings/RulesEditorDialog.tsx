/**
 * 规则全文编辑器弹层：ui/Dialog 基座装配（Esc/遮罩关闭在 saving 时守卫、
 * 初始聚焦 textarea、关闭后焦点归还「全文」按钮由基座 useRestoreFocus 接管）。
 */
import React from 'react';
import styles from './SettingsRulesTab.module.css';
import { Button, Dialog, Textarea } from '../ui';

export type RulesEditorDialogProps = {
  open: boolean;
  scopeLabel: string;
  /** 保存后写入位置（仅供 aria 描述） */
  storagePath: string;
  saving: boolean;
  editorText: string;
  onEditorTextChange: (v: string) => void;
  initialFocusRef: React.RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
  onSave: () => void;
};

export const RulesEditorDialog: React.FC<RulesEditorDialogProps> = ({
  open,
  scopeLabel,
  storagePath,
  saving,
  editorText,
  onEditorTextChange,
  initialFocusRef,
  onClose,
  onSave,
}) => {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={`编辑${scopeLabel}规则`}
      description={
        <span style={{ display: 'none' }}>{`保存后写入 ${storagePath} · 成功不提示`}</span>
      }
      classNames={{ panel: styles.rulesEditorDialog, overlay: styles.rulesEditorOverlay }}
      initialFocusRef={initialFocusRef}
      footer={
        <div className={styles.rulesEditorFoot}>
          <Button
            type="button"
            onClick={() => {
              if (!saving) onClose();
            }}
            variant="secondary"
            size="sm"
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={onSave}
            variant="secondary"
            size="sm"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      }
    >
      <Textarea
        bare
        ref={initialFocusRef}
        className={styles.rulesEditorTextarea}
        value={editorText}
        onChange={(e) => onEditorTextChange(e.target.value)}
        rows={12}
        spellCheck={false}
        disabled={saving}
        aria-label={`${scopeLabel}规则正文`}
        placeholder="每行一条规则；# 开头为标题"
      />
    </Dialog>
  );
};
