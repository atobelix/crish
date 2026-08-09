import React from 'react';
import styles from './ApprovalAskCard.module.css';

/** 补充说明输入区（可选备注 textarea + 字数统计） */
export const ApprovalNoteField: React.FC<{
  note: string;
  onNoteChange: (v: string) => void;
  busy: boolean;
  density: 'compact' | 'default';
  noteId: string;
}> = ({ note, onNoteChange, busy, density, noteId }) => {
  return (
    <label className={styles.approvalCardNote} htmlFor={noteId}>
      <span>补充说明（可选，也可直接写你的要求）</span>
      <textarea
        id={noteId}
        className={styles.approvalCardInput}
        rows={density === 'compact' && !note ? 1 : 2}
        maxLength={500}
        placeholder="例如：只允许这一次 / 不要改测试文件…"
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        disabled={busy}
        aria-label="补充说明（可选）"
      />
      {note.length > 0 || density === 'default' ? (
        <span
          className={styles.approvalCardCount}
          aria-hidden={note.length === 0}
        >
          {note.length}/500
        </span>
      ) : null}
    </label>
  );
};
