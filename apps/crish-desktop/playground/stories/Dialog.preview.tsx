import React, { useState } from 'react';
import {
  Dialog,
  ConfirmDialog,
  Button,
  type DialogSize,
} from '@/components/ui';
import styles from './story.module.css';

const SIZES: DialogSize[] = ['sm', 'md', 'lg', 'xl'];

export function DialogPreview() {
  const [openStandard, setOpenStandard] = useState(false);
  const [openConfirm, setOpenConfirm] = useState(false);
  const [dialogSize, setDialogSize] = useState<DialogSize>('md');

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Dialog 对话框 & ConfirmDialog</h1>
        </div>
        <p className={styles.description}>
          多层级模态弹窗系统：无侵入 FocusTrap 焦点陷阱、Esc
          弹栈与返回原焦点守护，挂载至独立 #modal-root Multi-Root Portal。
        </p>
        <code className={styles.importSnippet}>
          {"import { Dialog, ConfirmDialog } from '@/components/ui';"}
        </code>
      </header>

      {/* 交互控制台 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>交互演示 (Live Triggers)</h2>
        <div className={styles.knobCard}>
          <div className={styles.knobGrid}>
            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Dialog Size</span>
              <select
                className={styles.knobSelect}
                value={dialogSize}
                onChange={(e) => setDialogSize(e.target.value as DialogSize)}
              >
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.liveStage}>
            <div style={{ display: 'flex', gap: '16px' }}>
              <Button variant="primary" onClick={() => setOpenStandard(true)}>
                打开标准对话框 ({dialogSize})
              </Button>
              <Button variant="danger" onClick={() => setOpenConfirm(true)}>
                打开二次确认弹窗
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* 标准对话框 */}
      <Dialog
        open={openStandard}
        onClose={() => setOpenStandard(false)}
        size={dialogSize}
        title="创建新工作空间"
        description="为多 Agent 战役指定独立的代码执行与产物存储目录。"
        footer={
          <div
            style={{
              display: 'flex',
              gap: '8px',
              justifyContent: 'flex-end',
              width: '100%',
            }}
          >
            <Button variant="ghost" onClick={() => setOpenStandard(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => setOpenStandard(false)}>
              确认创建
            </Button>
          </div>
        }
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            padding: '12px 0',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: '13px',
              color: 'var(--text-secondary)',
            }}
          >
            在此弹窗中可以自由组合输入框、开关与表格，模态遮罩会自动阻断底层滚动与事件穿透。
          </p>
          <div
            style={{
              background: 'var(--surface-sunken)',
              padding: '12px',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
              Portal Target: #modal-root
            </span>
          </div>
        </div>
      </Dialog>

      {/* 危险操作二次确认对话框 */}
      <ConfirmDialog
        open={openConfirm}
        onConfirm={() => {
          setOpenConfirm(false);
          alert('操作已确认');
        }}
        onCancel={() => setOpenConfirm(false)}
        title="彻底清空当前会话缓存"
        description="此操作将重置内存中的所有活跃 Agent 状态与临时日志，且不可逆。是否继续？"
        confirmText="确认清空"
        cancelText="放弃"
        variant="danger"
      />
    </div>
  );
}
