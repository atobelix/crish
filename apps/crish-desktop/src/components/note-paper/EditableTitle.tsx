/**
 * EditableTitle.tsx — 笔记行内即时重命名组件
 *
 * 遵循极简直接操作模型（Direct Manipulation）：
 * - 展示态为交互式按钮（role="button"，非 heading 角色，零原生 DOM title）
 * - 单/双击进入输入态，自动全选文本
 * - 回车或失焦提交持久化重命名，Esc 还原放弃
 * - 边框对比度严守 AGENTS.md §13 规范（<= 10% 柔软微阶，box-shadow: none）
 * - 物理剔除原生 title 属性，全量换装项目自定义 <Tooltip>
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Input, Tooltip } from '../ui';
import styles from './NotePaperPanel.module.css';

export interface EditableTitleProps {
  /** 当前笔记标题 */
  title: string;
  /** 重命名提交回调（返回 Promise 或 void） */
  onRename?: (newTitle: string) => Promise<void> | void;
  /** 容器外层追加 className */
  className?: string;
  /** 空值回退占位符（默认：'无标题笔记'） */
  placeholder?: string;
}

export const EditableTitle: React.FC<EditableTitleProps> = React.memo(
  function EditableTitle({
    title,
    onRename,
    className,
    placeholder = '无标题笔记',
  }) {
    const [isEditing, setIsEditing] = useState<boolean>(false);
    const [draftText, setDraftText] = useState<string>(title || placeholder);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // 外部 title 属性发生变更时同步至草稿（仅在非编辑态下同步）
    useEffect(() => {
      if (!isEditing) {
        setDraftText(title || placeholder);
      }
    }, [title, placeholder, isEditing]);

    // 激活编辑态时自动聚焦并全选内容
    useEffect(() => {
      if (isEditing && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, [isEditing]);

    // 提交编辑变更
    const handleCommit = useCallback(async () => {
      setIsEditing(false);
      const trimmed = draftText.trim();
      const finalTitle = trimmed.length > 0 ? trimmed.slice(0, 120) : placeholder;

      if (finalTitle !== title && onRename) {
        try {
          await onRename(finalTitle);
        } catch (err) {
          console.error('[EditableTitle] 重命名持久化失败，回滚标题:', err);
          setDraftText(title || placeholder);
        }
      } else {
        setDraftText(finalTitle);
      }
    }, [draftText, placeholder, title, onRename]);

    // 键盘响应
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setDraftText(title || placeholder);
          setIsEditing(false);
        }
      },
      [title, placeholder]
    );

    const containerClasses = [styles.titleContainer, className]
      .filter(Boolean)
      .filter((val, idx, arr) => arr.indexOf(val) === idx)
      .join(' ');

    if (isEditing) {
      return (
        <div
          className={containerClasses}
          style={{
            border: 'none',
            outline: 'none',
            boxShadow: 'none',
            background: 'transparent',
          }}
        >
          <Input
            bare
            ref={inputRef}
            type="text"
            className={styles.titleInput}
            style={{
              border: 'none',
              outline: 'none',
              boxShadow: 'none',
              background: 'transparent',
            }}
            value={draftText}
            maxLength={120}
            placeholder={placeholder}
            onChange={(e) => setDraftText(e.target.value)}
            onBlur={() => {
              void handleCommit();
            }}
            onEnter={() => {
              void handleCommit();
            }}
            onKeyDown={handleKeyDown}
            aria-label="编辑笔记标题"
            data-testid="note-paper-strict-title-input"
          />
        </div>
      );
    }

    return (
      <div
        className={containerClasses}
        style={{
          border: 'none',
          outline: 'none',
          boxShadow: 'none',
          background: 'transparent',
        }}
      >
        <Tooltip content="点击编辑笔记标题">
          <span
            className={styles.titleDisplay}
            onClick={() => setIsEditing(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsEditing(true);
              }
            }}
            data-testid="note-paper-strict-title"
          >
            {title || placeholder}
          </span>
        </Tooltip>
      </div>
    );
  }
);

EditableTitle.displayName = 'EditableTitle';
export default EditableTitle;
