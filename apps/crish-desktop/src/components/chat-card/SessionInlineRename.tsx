import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Pencil } from 'lucide-react';
import { Tooltip } from '../ui';
import styles from './SessionInlineRename.module.css';

export interface SessionInlineRenameProps {
  title: string;
  onRename: (newTitle: string) => void;
  disabled?: boolean;
}

export const SessionInlineRename: React.FC<SessionInlineRenameProps> = ({
  title,
  onRename,
  disabled = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(title);
  }, [title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleCommit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    } else {
      setEditValue(title);
    }
    setIsEditing(false);
  }, [editValue, title, onRename]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      setEditValue(title);
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <div className={styles.renameContainer}>
        <input
          ref={inputRef}
          type="text"
          className={styles.renameInput}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={handleKeyDown}
          maxLength={64}
          aria-label="修改会话名称"
        />
      </div>
    );
  }

  return (
    <Tooltip content={disabled ? undefined : '点击修改会话名称'}>
      <button
        type="button"
        className={`${styles.titleBtn} ${disabled ? styles.disabled : ''}`}
        onClick={() => !disabled && setIsEditing(true)}
        disabled={disabled}
        aria-label={`会话名称：${title}`}
      >
        <span className={styles.titleText}>{title}</span>
      </button>
    </Tooltip>
  );
};
